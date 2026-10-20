import { io } from 'socket.io-client';

/**
 * Shared Socket.io client.
 * Connects to the same origin in production (reverse-proxy /socket.io),
 * or to VITE_BACKEND_URL during development.
 */
let socket = null;

export function getSocket() {
  if (!socket) {
    const url = import.meta.env.VITE_BACKEND_URL || undefined; // undefined => same origin
    socket = io(url, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    });
  }
  return socket;
}

export function randomId(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
