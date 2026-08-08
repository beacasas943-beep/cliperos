CLIPCONTROL 2.1 PRO - NETLIFY

SUBE A LA RAIZ DEL REPOSITORIO:
index.html
styles.css
app.js
supabase-config.js
_redirects
netlify.toml

NETLIFY:
Branch: main
Base directory: VACIO
Build command: VACIO
Publish directory: .

ANTES DE PUBLICAR LA WEB 2.1:
1) Ejecutar SQL 18.
2) Desplegar bright-processor/index.ts 2.1.
3) Ejecutar SQL 19 una sola vez.
4) Ejecutar SQL 20 para verificar.

NO cambiar CRON_SECRET.
NO crear una segunda Edge Function.
