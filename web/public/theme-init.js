// Runs before the stylesheet to restore the local theme without a light flash.
try {
  const saved = JSON.parse(localStorage.getItem('hlool-pdf:prefs-v3') || '{}')
  document.documentElement.dataset.theme = saved.theme === 'dark' ? 'dark' : 'light'
} catch { /* The default theme remains usable if localStorage is unavailable. */ }
