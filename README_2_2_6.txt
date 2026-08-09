CLIPCONTROL 2.2.6 — STABLE LIVE

OBJETIVO
- Las cifras NO bajan por lecturas inestables de las redes.
- La pantalla NO se redibuja por cada ciclo de sincronización.
- Solo una subida real de vistas/likes/comentarios/compartidos provoca actualización visual.
- Los cambios reales se agrupan y se pintan una sola vez mediante debounce.
- Se elimina el estado DB "syncing" en cada ciclo para evitar eventos Realtime innecesarios.
- El indicador superior permanece "En vivo" durante sincronizaciones silenciosas.

INSTALACION
1) WEB: reemplazar los 6 archivos del paquete WEB en la raiz de GitHub/Netlify.
2) SUPABASE: reemplazar SOLO el index.ts de bright-processor y Deploy updates.
3) NO ejecutar SQL. NO cambiar CRON_SECRET, Vault, Secrets ni Cron.
4) Hacer Ctrl+Shift+R tras el deploy de Netlify.

NOTA
Facebook, TikTok, YouTube e Instagram quedan monotónicos: si una consulta devuelve menos que el valor guardado, ClipControl conserva el valor mayor.
