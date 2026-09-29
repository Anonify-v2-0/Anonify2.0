PDF pages render in browsers without `Map.prototype.getOrInsertComputed`
(Chromium before 145, and many phone browsers). pdf.js 6 needs it, and the
review canvas used to sit on its loading spinner forever there. The browser
now loads pdf.js's legacy build, which carries its own polyfills
