/*******************************************************************************
 *
 * Copyright (c) 2011, Euan Goddard <euan.goddard@gmail.com>.
 * All Rights Reserved.
 *
 * This file is part of smtpevent <https://github.com/euangoddard/node-smtpevent>,
 * which is subject to the provisions of the BSD at
 * <https://github.com/euangoddard/node-smtpevent/raw/master/LICENCE>. A copy of
 * the license should accompany this distribution. THIS SOFTWARE IS PROVIDED "AS
 * IS" AND ANY AND ALL EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED, INCLUDING,
 * BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF TITLE, MERCHANTABILITY, AGAINST
 * INFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE.
 *
 *******************************************************************************
 */


/**
 * @author Euan Goddard
 * @version 0.0.2
 */

var net = require('net'),
    events = require('events'),
    util = require('util'),
    tls = require('tls');
    
function SMTPServer(hostname, opts) {
    net.Server.call(this);

    this.hostname = hostname || require('os').hostname();
    this.name = opts && opts.name || 'node.js smtpevent server';
    this.version = opts && opts.version || '0.0.2';
    this.log = opts && opts.log || function () { util.log(Array.prototype.slice.call(arguments).join(' ')); }

    this.stats = { messages: { total: 0 }, connections: { current: 0, max: 0, total: 0 } };

    this.register = function(connection) {
        this.stats.connections.max = Math.max(++this.stats.connections.current, this.stats.connections.max);
        ++this.stats.connections.total;
    }.bind(this);

    this.unregister = function(connection) {
        this.log('Connection', connection.id, 'unregistering', connection.socket.remoteAddress);
        --this.stats.connections.current;
    }.bind(this);

    this.log_stats = function() { this.log(JSON.stringify(this.stats)); }.bind(this);

    // connection will call this method when a complete message is received
    // TODO should pass this as arg to connection?
    this.incoming = function (remoteAddress, mailfrom, rcpttos, data) {
      ++this.stats.messages.total;
      this.emit('incoming-mail', remoteAddress, mailfrom, rcpttos, data);
    }.bind(this);

    this.on('connection', (function (socket) {
        this.log('New SMTP connection from: ' + socket.remoteAddress);
        new SMTPConnection(this, socket);
    }).bind(this));

    this.once("listening", function () {
      this.log('SMTP server listening at ' + this.hostname + ':' + this.address().port);
    });
};
util.inherits(SMTPServer, net.Server);

var SMTPProtocol = {
  syntax: {
    HELO: 'hostname',
    EHLO: 'hostname',
    NOOP: null,
    QUIT: undefined,
    MAIL: 'FROM:<address>',
    RCPT: 'TO: <address>',
    RSET: null,
    DATA: null
  },
  regex: { 
    // regex for matching any incoming verb
    verb:  /^(?:\s*)([A-Za-z]{4,8}) ?(.*)(?:\s|\r|\n)*$/,
    // regex for matching an incoming email address (as provided in the MAIL FROM: or RCPT TO: commands)
    email: /^\s*(?:FROM:|TO:)\s*<\s*?([^>]*)\s*>?\s*$/i,
  },
  EOL: '\r\n'
};
    
function SMTPConnection(server, socket) {

    this.id = Math.random() * 1e10 >>> 0;

    events.EventEmitter.call(this);

    this.socket = null; // set below
    this.greeting = null;
    this.server = server;
    this.reset(); // initialize envelope and message data

    // add listeners for all of our supported verbs
    for (verb in this.handlers) this.on(verb, this.handlers[verb].bind(this));
        
    // create bound versions of the socket listeners
    this.onVerb = SMTPConnection.prototype.onVerb.bind(this);
    this.onData = SMTPConnection.prototype.onData.bind(this);
    
    this.server.register(this);

    this.setSocket = function (s) {
      if (this.sockets === s) return;
      // remove listeners from old socket (if there was one)
      if (this.socket) {
        this.socket.removeListener('data', this.onVerb);
        this.socket.removeAllListeners('close');
      }
      this.greeting = null; // allow another HELO/EHLO
      this.socket = s;
      // add listeners to new socket (if there is one)
      if (this.socket) {
        this.socket.on('data', this.onVerb);
        this.socket.on('close', function () {
            this.server.unregister(this);
            delete this;
        }.bind(this));
      }
    }.bind(this);

    this.setSocket(socket);

    this.respondWelcome();
}

util.inherits(SMTPConnection, events.EventEmitter);

const tlsOptions = require('./tls-options');

SMTPConnection.prototype.starttls = function () {
    if (this.socket instanceof tls.TLSSocket) {
      return this.server.log("starttls: socket is already TLSSocket")
    }

    let socketOptions = {
        isServer: true,
        server: this.server,
    };

    socketOptions = tlsOptions(socketOptions);

    secureContext = tls.createSecureContext(socketOptions);

    socketOptions.SNICallback = function (servername, callback) { callback(null, secureContext); };

    let returned = false;
    let onError = err => {
        console.log("starttls: onError", err)
        if (returned) return;
        returned = true;
        // TODO: raise an error on the server?
    };

    this.socket.once('error', onError);
      
    // upgrade connection
    this.server.log("starttls: creating TLSSocket...")
    let tlsSocket = new tls.TLSSocket(this.socket, socketOptions);

    const unexpected_events = ['close', 'error', '_tlsError', 'clientError', 'tlsClientError']

    unexpected_events.forEach((e) => tlsSocket.once(e, onError));

    tlsSocket.on('secure', function () {
        this.socket.removeListener('error', onError);
        unexpected_events.forEach((e) => tlsSocket.removeListener(e, onError));
        if (returned) {
            try {
                tlsSocket.end();
            } catch (E) {
                //
            }
            return;
        }
        returned = true;

        this.server.log("starttls: tlsSocket.on('secure') replacing connection socket...")
        this.setSocket(tlsSocket);
        // this.connections.add(connection);
        // connection.on('error', err => this._onError(err));
        // connection.on('connect', data => this._onClientConnect(data));
        // connection.init();
    }.bind(this));
};

SMTPConnection.prototype.reset = function () {
    this.mailfrom = null;
    this.rcpttos = [];
    this.current_data = [];
};

/**
 * Extract the address ensuring that any <> are correctly removed
 * @param {String} argument
 * @return {String} The cleaned address
 */
SMTPConnection.prototype.parse_email_address = function (argument) {
    var m = SMTPProtocol.regex.email.exec(argument)
    return m && m[1];
};

/**
 * Emit a response to the client
 * @param {Number} code
 * @param {String} message
 */
SMTPConnection.prototype.respond = function (code, message) { this.socket.write("" + code + " " + message + SMTPProtocol.EOL); }
// sugar for common responses
SMTPConnection.prototype.respondOk = function () { this.respond(250, "Ok"); }
SMTPConnection.prototype.respondSyntax = function (verb) { this.respond(501, "Syntax: " + verb + (SMTPProtocol.syntax[verb] ? " " + SMTPProtocol.syntax[verb] : "")); };
SMTPConnection.prototype.respondWelcome = function () { this.respond(220, [this.server.hostname, this.server.name, this.server.version].join(' ')); };
// for ESMTP EHLO response
SMTPConnection.prototype.writeExtension = function (code, message) { this.socket.write("" + code + "-" + message + SMTPProtocol.EOL); }


/**
 * Functions to handle incoming SMTP verbs
 */
SMTPConnection.prototype.handlers = {
    HELO: function (argument) {
        if (this.greeting) return this.respond(503, 'Duplicate HELO/EHLO');
        this.greeting = argument;
        return this.respond(250, this.server.hostname + ' Hello ' + this.socket.remoteAddress);
    },
    EHLO: function (argument) {
        if (this.greeting) return this.respond(503, 'Duplicate HELO/EHLO');
        this.greeting = argument;
        this.writeExtension(250, this.server.hostname + ' Hello ' + this.socket.remoteAddress);
        return this.respond(250, "STARTTLS");
    },
    MAIL: function (argument) {
        if (this.mailfrom) return this.respond(503, 'Error: nested MAIL command');
        this.mailfrom = this.parse_email_address(argument);
        if (this.mailfrom == null) return this.respondSyntax("MAIL"); // note that empty string is considered ok
        return this.respondOk();
    },
    RCPT: function (argument) {
        if (this.mailfrom == null) return this.respond(503, 'Error: need MAIL command');
        var address = this.parse_email_address(argument);
        if (!address) return this.respondSyntax('RCPT');
        var next = function (error, data) {
          if (error) return this.respond(553, error);
          this.rcpttos.push(data);
          return this.respondOk();
        }.bind(this);
        if (events.EventEmitter.listenerCount(this.server, 'recipient')) {
          // TODO: add a timeout in case validation takes to long?
          this.server.emit("recipient", address, next);
        } else {
          next(null, address);
        }
    },
    STARTTLS: function () {
      this.respond(220, 'Ready to start TLS');
      return this.starttls();
    },
    DATA: function () {
        if (!this.rcpttos.length) return this.respond(503, 'Error: need RCPT command');
        this.listenForData();
        return this.respond(354, 'End data with <CR><LF>.<CR><LF>');
    },
    QUIT: function () {
        this.respond(221, this.server.hostname + ' closing connection');
        this.socket.end();
    },
    RSET: function () {
        this.reset(); 
        return this.respondOk();
    },
    NOOP: function () {
        this.respondOk();
    }
};

/**
 * Handle the situation where the client is issuing SMTP commands
 */
SMTPConnection.prototype.onVerb = function (buffer) {
    this.server.log("connection", this.id, "onVerb", buffer.toString())
    var matches = buffer.toString().match(SMTPProtocol.regex.verb);
    if (!matches) return this.respond(500, 'Error: bad syntax');

    var command = matches[1].toUpperCase(), argument = matches[2];

    // see if this is a command we can handle
    if (!(command in this.handlers)) return this.respond(502, 'Error: command "' + command + '" not implemented');

    // validate presence of argument if expected, or lack thereof if expected, or ignorability thereof...
    var expected = SMTPProtocol.syntax[command];
    if (typeof(expected) != "undefined" && !!expected != !!argument) return this.respondSyntax(command);

    return this.emit(command, argument);
};

/**
 * Handle the case where the client is transmitting data (i.e. not a command)
 */
SMTPConnection.prototype.onData = function (buffer) {
    this.server.log("connection", this.id, "onData", buffer.toString())
  var lines = buffer.toString().split('\r\n');
  for (var i = 0; i < lines.length; i++) {
      if (lines[i].match(/^\.$/)) { // we've reached the end of the data
        // hand the completed message off to the server
        this.server.incoming(this.socket.remoteAddress, this.mailfrom, this.rcpttos, this.current_data.join('\n'));
        this.reset();
        this.listenForVerbs();
        return this.respondOk();
      } else {
        this.current_data.push(lines[i].replace(/^\./, '')); // remove transparency according to RFC 821, Section 4.5.2
      }
  }
};

SMTPConnection.prototype.listenForVerbs = function () {
  this.socket.removeAllListeners('data');
  this.socket.on('data', this.onVerb);
};

SMTPConnection.prototype.listenForData = function () {
  this.socket.removeAllListeners('data');
  this.socket.on('data', this.onData);
};

// Export public API:
exports.SMTPServer = SMTPServer;
