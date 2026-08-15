ClipControl 2.6.3 - LINK VALIDATION HOTFIX

Qué corrige:
- El frontend ya no rechaza rutas válidas de Facebook/TikTok/YouTube/Instagram por regex demasiado estrictas.
- Solo valida dominio/plataforma y deja a bright-processor resolver el enlace.
- app.js e index.html fuerzan revalidación de caché para que Netlify no sirva el validador viejo.

NO toca:
- Edge Function bright-processor
- SQL
- motor de Facebook que ya funciona
- métricas guardadas

Instalación:
1) Reemplaza index.html, app.js y netlify.toml en Netlify/repo.
2) Puedes mantener styles.css, supabase-config.js y admin-panel-fix iguales; se incluyen por comodidad.
3) Deploy.
4) Ctrl+Shift+R.
5) En consola ejecuta: clipcontrolDebugFrontend()
   Debe mostrar version: 2.6.3-link-validation y ok:true en los ejemplos.
