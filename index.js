const crypto = require('crypto')
const { EventEmitter } = require('events')

const datEncoding = require('dat-encoding')
const HypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const pump = require('pump')

const log = require('debug')('corestore:network')

const OUTER_STREAM = Symbol('corestore-outer-stream')

class SwarmNetworker extends EventEmitter {
  constructor (corestore, opts = {}) {
    super()
    this.corestore = corestore
    this.id = opts.id || crypto.randomBytes(32)
    this.opts = opts

    this._replicationOpts = {
      id: this.id,
      encrypt: true,
      live: true,
      keyPair: opts.keyPair || HypercoreProtocol.keyPair()
    }

    this._seeding = new Set()
    this._replicationStreams = []

    // Set in listen
    this._swarm = null
  }

  _replicate (protocolStream) {
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.corestore.replicate(false, {
      ...this._replicationOpts,
      stream: protocolStream,
    })
  }

  listen (opts = {}) {
    const self = this
    if (this._swarm) return

    this._swarm = hyperswarm({
      ...this.opts,
      queue: { multiplex: true }
    })
    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return null

      // We block all the corestore's ifAvailable guards until the connection's handshake has succeeded or the stream closes.
      let handshaking = true
      this.corestore.guard.wait()

      const protocolStream = new HypercoreProtocol(isInitiator, { ...this._replicationOpts, ...opts })
      protocolStream.on('handshake', () => {
        const deduped = info.deduplicate(protocolStream.publicKey, protocolStream.remotePublicKey)
        if (deduped) {
          console.log('deduped')
          ifAvailableContinue()
          return
        }
        onhandshake()
      })
      protocolStream.on('close', () => {
        this.emit('stream-closed', protocolStream)
        ifAvailableContinue()
      })

      pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
        const idx = this._replicationStreams.indexOf(protocolStream)
        if (idx === -1) return
        this._replicationStreams.splice(idx, 1)
      })

      this.emit('stream-opened', protocolStream)

      function onhandshake () {
        console.log('handshake complete!')
        self._replicate(protocolStream)
        self._replicationStreams.push(protocolStream)
        self.emit('handshake', protocolStream)
        ifAvailableContinue()
      }

      function ifAvailableContinue () {
        if (handshaking) {
          handshaking = false
          self.corestore.guard.continue()
        }
      }
    })
  }

  async seed (discoveryKey, opts = {}) {
    if (!this._swarm) throw new Error('Seed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return null

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    this._seeding.add(keyString)
    return new Promise((resolve, reject) => {
      this._swarm.join(keyBuf, {
        announce: opts.announce !== false,
        lookup: opts.lookup !== false
      }, err => {
        if (err) return reject(err)
        if (opts.flush !== false) {
          return this._swarm.flush(err => {
            if (err) return reject(err)
            return resolve(null)
          })
        }
        return resolve(null)
      })
    })
  }

  unseed (discoveryKey) {
    if (!this._swarm) throw new Error('Unseed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    this._seeding.delete(keyString)
    this._swarm.leave(keyBuf)

    for (let stream of this._replicationStreams) {
      stream.close(keyBuf)
    }
  }

  async close () {
    if (!this._swarm) return null
    return new Promise((resolve, reject) => {
      for (const dkey of [...this._seeding]) {
        this.unseed(dkey)
      }
      for (const stream of this._replicationStreams) {
        stream.destroy()
      }
      this._swarm.destroy(err => {
        if (err) return reject(err)
        this._swarm = null
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker
