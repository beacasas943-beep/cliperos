// La publishable key está diseñada para usarse en el navegador con RLS activo.
// Nunca coloques aquí una secret key ni service_role.
window.CLIPCONTROL_SUPABASE = {
  version: "3.6.0-payment-distribution",
  url: "https://ngtdobnwgwqimdjzzudl.supabase.co",
  publishableKey: "sb_publishable_FUfr0aTUIkSs5pkdPODoLg_fdTsLENz",
  // Slug real que aparece en la URL de tu Edge Function.
  adminFunction: "bright-processor",
  // Herramientas window.clipcontrolDebug* desactivadas en producción.
  debug: false,
  // Permite que el primer administrador escriba "admin" en lugar de su correo.
  loginAliases: {
    admin: "sotorommel33@gmail.com"
  }
};
