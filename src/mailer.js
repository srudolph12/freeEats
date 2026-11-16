'use strict';

/**
 * FreeEats - sends sign-in emails over SMTP with TLS (port 465), using only Node built-ins.
 *
 * Configure with environment variables:
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   default 465 (implicit TLS; STARTTLS on 587 is not supported)
 *   SMTP_USER   login name
 *   SMTP_PASS   password or app password
 *   MAIL_FROM   sender address, default SMTP_USER
 *
 * With no SMTP_HOST set, emails are printed to the server console instead, which is
 * handy for local development.
 */

const tls = require('node:tls');
const crypto = require('node:crypto');

function createMailer(env) {
  env = env || process.env;
  if (!env.SMTP_HOST) {
    return async function logMail(msg) {
      console.log('\n[email not configured: printing instead]\nTo: ' + msg.to + '\nSubject: ' + msg.subject + '\n\n' + msg.text);
    };
  }
  const cfg = {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 465,
    user: env.SMTP_USER || '',
    pass: (env.SMTP_PASS || '').replace(/\s+/g, ''), // app passwords are often copied with spaces
    from: env.MAIL_FROM || env.SMTP_USER || '',
  };
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(cfg.from)) throw new Error('Set MAIL_FROM (or SMTP_USER) to a plain email address.');
  return (msg) => smtpSend(cfg, msg);
}

async function smtpSend(cfg, msg) {
  if (/[\r\n]/.test(msg.to + msg.subject)) throw new Error('Invalid email header');

  const sock = tls.connect(Object.assign({ host: cfg.host, port: cfg.port, servername: cfg.host }, cfg.tls));
  sock.setEncoding('utf8');
  sock.setTimeout(20000, () => sock.destroy(new Error('SMTP server timed out')));

  const replies = [];
  const waiting = [];
  let failure = null;
  let buf = '';
  let lines = [];
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (line[3] === '-') continue; // multi-line reply continues
      const reply = { code: Number(line.slice(0, 3)), text: lines.join(' | ') };
      lines = [];
      const w = waiting.shift();
      if (w) w.resolve(reply);
      else replies.push(reply);
    }
  });
  const fail = (err) => {
    failure = failure || err;
    while (waiting.length) waiting.shift().reject(failure);
  };
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('SMTP connection closed')));

  const read = () => {
    if (replies.length) return Promise.resolve(replies.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  // Send a line (or nothing, for the greeting) and check the reply code.
  const step = async (label, line, okCodes) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await read();
    if (okCodes.indexOf(r.code) === -1) throw new Error('SMTP ' + label + ' failed: ' + r.text);
  };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  const domain = cfg.from.split('@')[1];
  const message = [
    'From: FreeEats <' + cfg.from + '>',
    'To: <' + msg.to + '>',
    'Subject: ' + (/[^\x20-\x7e]/.test(msg.subject) ? '=?UTF-8?B?' + b64(msg.subject) + '?=' : msg.subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomUUID() + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
  ]
    .concat(msg.text.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l))) // dot-stuffing
    .join('\r\n');

  try {
    await step('greeting', null, [220]);
    await step('EHLO', 'EHLO ' + domain, [250]);
    if (cfg.user) {
      await step('AUTH', 'AUTH LOGIN', [334]);
      await step('AUTH username', b64(cfg.user), [334]);
      await step('AUTH password', b64(cfg.pass), [235]);
    }
    await step('MAIL FROM', 'MAIL FROM:<' + cfg.from + '>', [250]);
    await step('RCPT TO', 'RCPT TO:<' + msg.to + '>', [250, 251]);
    await step('DATA', 'DATA', [354]);
    await step('message', message + '\r\n.', [250]);
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

module.exports = { createMailer, smtpSend };
