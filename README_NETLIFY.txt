CLIPCONTROL 1.5.1 - PAQUETE RAIZ PARA NETLIFY

IMPORTANTE:
Sube ESTOS ARCHIVOS DIRECTAMENTE a la raíz del repositorio de GitHub.
No subas la carpeta contenedora como una carpeta adicional.

En la raíz del repositorio deben verse juntos:
- index.html
- styles.css
- app.js
- supabase-config.js
- netlify.toml
- _redirects

Configuración Netlify:
- Base directory: vacío
- Build command: vacío
- Publish directory: .
- Production branch: main

Luego usa Deploys > Trigger deploy > Clear cache and deploy site.
