CLIPCONTROL 2.2.4 — REPORTES = INICIO

Esta actualización es SOLO WEB. No requiere SQL ni cambiar bright-processor.

CAMBIOS
- En administración se elimina la sección Reportes del menú.
- Inicio ahora abre directamente la evaluación de cliperos del período.
- Se elimina el antiguo dashboard administrativo como pantalla inicial.
- Estados con color semántico:
  Amarillo = En elaboración
  Azul = Enviado / En revisión
  Rojo = Observado / Vencido
  Verde = Aprobado / Pagado
  Violeta = Pago pendiente
- Botón Evaluar ahora es una acción azul/violeta visible.
- Nombres y métricas aumentados para evitar forzar la vista.
- En móvil la tabla se convierte en tarjetas compactas y centradas.
- Clipero usa los mismos badges de estado en su inicio.
- Navegación reemplaza emojis por iconos SVG profesionales.

INSTALACIÓN
1. Reemplazar en la raíz de GitHub:
   index.html
   styles.css
   app.js
   supabase-config.js
   _redirects
   netlify.toml
2. Commit.
3. Esperar Netlify Published.
4. Ctrl + Shift + R.

NO EJECUTAR SQL.
NO MODIFICAR EDGE FUNCTIONS.
