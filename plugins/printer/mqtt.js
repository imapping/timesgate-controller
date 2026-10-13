// Just enough MQTT 3.1.1 (over TLS) to read a Bambu Lab printer's reports: connect, subscribe, publish
// and keep alive, all at QoS 0. Written here so the plugin needs no extra packages.
//   const m = connect({ host, port, username, password, clientId });
//   m.on('connect'), m.on('message', (topic, buf)), m.on('close', err)
//   m.subscribe(topic), m.publish(topic, string), m.end()
const tls = require('tls');
const { EventEmitter } = require('events');

const REFUSED = { 1: 'unsupported protocol', 2: 'client id refused', 3: 'server unavailable', 4: 'wrong user name or password', 5: 'not authorised' };

function lengthBytes(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
const str = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const packet = (first, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([first]), lengthBytes(body.length), body]); };

function connect({ host, port = 8883, username, password, clientId, keepalive = 30, timeout = 10000 }) {
  const ev = new EventEmitter();
  let buf = Buffer.alloc(0), ready = false, closed = false, ping = null, nextId = 1, closeErr = null;
  // The printer's certificate is signed by Bambu's own authority and names the serial number, not the address,
  // so it can't be checked the usual way. Only on your own network.
  const sock = tls.connect({ host, port, rejectUnauthorized: false, timeout });
  const fail = err => { if (!closeErr) closeErr = err; sock.destroy(); };

  sock.on('secureConnect', () => {
    sock.setTimeout(keepalive * 3000);
    sock.write(packet(0x10, str('MQTT'), Buffer.from([4, 0xC2, keepalive >> 8, keepalive & 255]), str(clientId), str(username), str(password)));
  });
  sock.on('timeout', () => fail(new Error(ready ? 'the printer stopped answering' : 'no answer from the printer')));
  sock.on('error', fail);
  sock.on('close', () => {
    clearInterval(ping);
    if (closed) return;
    closed = true;
    ev.emit('close', closeErr || new Error('the printer closed the connection'));
  });
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;; i++) {
        if (i >= buf.length) return;   // the length isn't all here yet
        len += (buf[i] & 127) * mul; mul *= 128;
        if (!(buf[i] & 128)) break;
        if (i >= 4) return fail(new Error('bad packet from the printer'));
      }
      const start = i + 1;
      if (buf.length < start + len) return;
      const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.subarray(start, start + len);
      buf = buf.subarray(start + len);
      if (type === 2) {   // CONNACK
        if (body[1] !== 0) return fail(Object.assign(new Error(REFUSED[body[1]] || 'refused (' + body[1] + ')'), { refused: body[1] }));
        ready = true;
        ping = setInterval(() => sock.write(Buffer.from([0xC0, 0])), keepalive * 1000);
        ev.emit('connect');
      } else if (type === 3) {   // PUBLISH
        const tl = body.readUInt16BE(0), topic = body.toString('utf8', 2, 2 + tl);
        let at = 2 + tl;
        const qos = (flags >> 1) & 3;
        if (qos) {   // (we subscribe at QoS 0, but acknowledge anything else politely)
          const id = body.readUInt16BE(at); at += 2;
          if (qos === 1) sock.write(Buffer.from([0x40, 2, id >> 8, id & 255]));
        }
        ev.emit('message', topic, body.subarray(at));
      } else if (type === 9) {   // SUBACK
        if (body[2] === 0x80) fail(Object.assign(new Error('not allowed to read the printer\'s reports'), { refused: 5 }));
      }
    }
  });

  ev.subscribe = topic => { const id = nextId++; sock.write(packet(0x82, Buffer.from([id >> 8, id & 255]), str(topic), Buffer.from([0]))); };
  ev.publish = (topic, message) => sock.write(packet(0x30, str(topic), Buffer.from(message, 'utf8')));
  ev.end = () => { if (closed) return; closed = true; clearInterval(ping); try { sock.end(Buffer.from([0xE0, 0])); } catch {} sock.destroy(); };
  return ev;
}

module.exports = { connect };
