#!/bin/sh
set -e
if [ -n "$REVOLVER_API_KEY" ]; then
  envsubst '${REVOLVER_API_KEY}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
else
  cp /etc/nginx/templates/default.conf.template /etc/nginx/conf.d/default.conf
  sed -i 's/proxy_set_header Authorization "Bearer ${REVOLVER_API_KEY}";//' /etc/nginx/conf.d/default.conf || true
fi
exec nginx -g 'daemon off;'
