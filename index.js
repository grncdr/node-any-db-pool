var inherits     = require('util').inherits
var EventEmitter = require('events').EventEmitter
var Pool         = require('generic-pool').Pool
var once         = require('once')
var chain        = require('./lib/chain')

module.exports = ConnectionPool

inherits(ConnectionPool, EventEmitter)

function ConnectionPool(adapter, connParams, options) {
  if (!(this instanceof ConnectionPool)) {
    return new ConnectionPool(adapter, connParams, options)
  }
  EventEmitter.call(this)

  var onConnect = options.onConnect;

  var poolOpts = {
    min: options.min,
    max: options.max,
    create: onConnect ?
      function (ready) {
        adapter.createConnection(connParams, function (err, conn) {
          if (err) ready(err);
          else onConnect(conn, ready)
        })
      }
      : function (ready) { adapter.createConnection(connParams, ready) }
    ,

    destroy: function (conn) {
      conn.end()
      conn._events = {}
    },

    log: options.log
  }

  var resetSteps = [];
  if (adapter.reset) resetSteps.unshift(adapter.reset)
  if (options.reset) resetSteps.unshift(options.reset)
  this.adapter = adapter.name
  this._adapter = adapter
  this._reset = chain(resetSteps)
  this._pool = new Pool(poolOpts)
}

ConnectionPool.prototype.query = function (statement, params, callback) {
  var self = this
    , query = this._adapter.createQuery(statement, params, callback)

  this.acquire(function (err, conn) {
    if (err) {
      if (typeof params === 'function') {
        return params(err)
      } else if (callback) {
        return callback(err);
      } else {
        return query.emit('error', err);
      }
    }
    conn.query(query);
    self.emit('query', query)
    var release = once(self.release.bind(self, conn))
    query.once('end', release).once('error', function (err) {
      release()
      // If this was the only error listener, re-emit the error.
      if (!this.listeners('error').length) {
        this.emit('error', err)
      }
    })
  })

  return query
}

ConnectionPool.prototype.acquire = function (callback) {
  this.emit('acquire')
  this._pool.acquire(callback);
}

ConnectionPool.prototype.release = function (connection) {
  this.emit('release')
  var pool = this._pool
  this._reset(connection, function (err) {
    if (err) return pool.destroy(connection)
    pool.release(connection)
  })
}

ConnectionPool.prototype.destroy = function (connection) {
  this._pool.destroy(connection)
}

ConnectionPool.prototype.close = function (callback) {
  var self = this
  this._pool.drain(function () {
    self._pool.destroyAllNow()
    self.emit('close')
    if (callback) callback()
  })
}

ConnectionPool.prototype.begin = function (beginStatement, callback) {
  if (typeof beginStatement == 'function') {
    callback = beginStatement
    beginStatement = null
  }

  if (typeof this._adapter.createTransaction != 'function') {
    var err = new Error("Adapter does not support transactions")
    return callback ? callback(err) : this.emit('error', err)
  }

  var tx = this._adapter.createTransaction(beginStatement, callback)

  var pool = this
  this.acquire(function (err, connection) {
    if (err) return tx.emit('error', err);
    var release = pool.release.bind(pool, connection)
    tx.once('rollback:complete', release)
      .once('commit:complete', release)
      .setConnection(connection)
  })

  return tx;
}
