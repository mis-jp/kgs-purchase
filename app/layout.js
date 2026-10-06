import "./globals.css";
import AuthBootstrap from "@/components/AuthBootstrap";
import BackgroundIncrementalSync from "@/components/BackgroundIncrementalSync";
import ConnectionWarning from "@/components/ConnectionWarning";
import { ThemeProvider } from "@/components/ThemeProvider";
import { withBasePath } from "@/lib/base-path";

export const metadata = {
  title: "KGS PURCHASING",
  description: "Sign in to your account",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href={`${withBasePath("/kelin-logo.png")}`} type="image/png" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme');
                  var supportDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches === true;
                  if (theme === 'dark' || (!theme && supportDarkMode)) {
                    document.documentElement.setAttribute('data-theme', 'dark');
                    document.documentElement.style.backgroundColor = '#000000';
                  } else {
                    document.documentElement.setAttribute('data-theme', 'light');
                    document.documentElement.style.backgroundColor = '#f8fafc';
                  }
                } catch (e) {}

                // Browsers and password tools stamp fdprocessedid onto buttons
                // before React hydrates, which shows a false page error on refresh.
                try {
                  var strip = function (el) {
                    if (el && el.removeAttribute && el.hasAttribute && el.hasAttribute('fdprocessedid')) {
                      el.removeAttribute('fdprocessedid');
                    }
                  };
                  var stripTree = function (node) {
                    if (!node || node.nodeType !== 1) return;
                    strip(node);
                    if (!node.querySelectorAll) return;
                    var marked = node.querySelectorAll('[fdprocessedid]');
                    for (var i = 0; i < marked.length; i++) strip(marked[i]);
                  };
                  var observer = new MutationObserver(function (records) {
                    for (var i = 0; i < records.length; i++) {
                      var rec = records[i];
                      if (rec.type === 'attributes') strip(rec.target);
                      var added = rec.addedNodes || [];
                      for (var j = 0; j < added.length; j++) stripTree(added[j]);
                    }
                  });
                  observer.observe(document.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['fdprocessedid']
                  });
                  window.addEventListener('load', function () {
                    setTimeout(function () { observer.disconnect(); }, 2000);
                  });
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AuthBootstrap />
          <BackgroundIncrementalSync />
          <ConnectionWarning />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
