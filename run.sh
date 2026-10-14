#!/bin/sh
set -e
cd /app/server
exec node --no-warnings src/index.js
