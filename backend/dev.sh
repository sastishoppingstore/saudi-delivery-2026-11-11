#!/bin/bash
# Fiasta dev server starter — kills the instance recorded in /tmp/fiasta.pid, starts fresh.
cd /home/ubuntu/saudi-delivery/backend
if [ -f /tmp/fiasta.pid ]; then
  kill "$(cat /tmp/fiasta.pid)" 2>/dev/null
  rm -f /tmp/fiasta.pid
  sleep 1
fi
nohup env JWT_SECRET=devsecret_fiasta_2025 node --disable-warning=ExperimentalWarning src/server.js > /tmp/fiasta.log 2>&1 &
echo $! > /tmp/fiasta.pid
sleep 2
tail -2 /tmp/fiasta.log
curl -s localhost:3000/health
