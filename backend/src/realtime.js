import { verifyToken } from './auth.js';
import { get } from './db.js';

let io = null;

/** Attach Socket.IO. Rooms: user:<id>, role:drivers, role:admins, order:<id>. */
export function initRealtime(server) {
  return import('socket.io').then(({ Server }) => {
    io = new Server(server, { cors: { origin: '*' } });

    io.use((socket, next) => {
      const payload = verifyToken(socket.handshake.auth?.token);
      if (!payload) return next(new Error('unauthorized'));
      const user = get('SELECT id, role, active FROM users WHERE id = ?', payload.sub);
      if (!user || !user.active) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    });

    io.on('connection', (socket) => {
      const { id, role } = socket.data.user;
      socket.join(`user:${id}`);
      if (role === 'admin' || role === 'super_admin') socket.join('role:admins');
      if (role === 'driver') socket.join('role:drivers');

      socket.on('order:join', (orderId) => {
        const o = get('SELECT customer_id, driver_id FROM orders WHERE id = ?', orderId);
        if (o && (o.customer_id === id || o.driver_id === id || role === 'admin' || role === 'super_admin')) {
          socket.join(`order:${orderId}`);
        }
      });

      socket.on('order:chat', ({ orderId, body }) => {
        const text = String(body || '').slice(0, 500);
        if (!text) return;
        const o = get('SELECT customer_id, driver_id FROM orders WHERE id = ?', orderId);
        if (!o || (o.customer_id !== id && o.driver_id !== id)) return;
        const msg = { orderId, senderId: id, senderName: socket.data.user.name, body: text, at: new Date().toISOString() };
        getDbInsert(msg);
        io.to(`order:${orderId}`).emit('order:chat', msg);
      });
    });
    return io;
  });
}

import { run } from './db.js';
function getDbInsert(msg) {
  run('INSERT INTO chat_messages (order_id, sender_id, body) VALUES (?, ?, ?)', msg.orderId, msg.senderId, msg.body);
}

const safe = (fn) => { try { fn(); } catch (err) { console.error('[realtime]', err.message); } };

export function emitToUser(userId, event, data) {
  safe(() => io?.to(`user:${userId}`).emit(event, data));
}

export function emitToDrivers(event, data) {
  safe(() => io?.to('role:drivers').emit(event, data));
}

export function emitToAdmins(event, data) {
  safe(() => io?.to('role:admins').emit(event, data));
}

/** Emit to the order room plus each party's personal room. */
export function broadcastOrder(orderId, event, data) {
  if (!io) return;
  safe(() => {
    io.to(`order:${orderId}`).emit(event, data);
    const o = get('SELECT customer_id, driver_id FROM orders WHERE id = ?', orderId);
    if (o) {
      if (o.customer_id) io.to(`user:${o.customer_id}`).emit(event, data);
      if (o.driver_id) io.to(`user:${o.driver_id}`).emit(event, data);
    }
    io.to('role:admins').emit(event, data);
  });
}
