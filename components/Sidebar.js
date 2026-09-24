"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DataCache } from "@/lib/data-cache";
import { fetchWithAuth } from "@/lib/api-client";
import { useTheme } from "./ThemeProvider";
import SessionStatus from "./SessionStatus";
import AutoSyncIndicator from "./AutoSyncIndicator";
import TourGuide from "./TourGuide";
import { withBasePath } from "@/lib/base-path";
import { APP_VERSION } from "@/lib/app-version";
import { storeAllowedModules } from "@/lib/user-access-client";
import { FORECAST_MODULE, userCanAccessModule } from "@/lib/module-access";
import "@/styles/sidebar.css";
/* ── SVG Icons ─────────────────────────────────────────── */
const IconInventory = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m7.5 4.27 9 5.15" /><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
  </svg>
);

const IconStock = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 7h10" /><path d="M7 12h10" /><path d="M7 17h10" />
  </svg>
);

const IconPO = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

const IconSales = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" />
  </svg>
);

const IconTruck = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 17h4V5H2v12h3" /><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L17 7h-3v10" /><circle cx="7.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" />
  </svg>
);

const IconSparkles = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" /><path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />
  </svg>
);

const IconForecast = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
  </svg>
);

const IconSync = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
  </svg>
);

const IconSun = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const IconMoon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

const IconAdmin = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const IconAccount = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export default function Sidebar() {
  const pathname = usePathname();
  const { isDarkMode, toggleTheme, mounted: themeMounted } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [userName, setUserName] = useState("Admin User");
  const [userRole, setUserRole] = useState("");
  const [allowedModules, setAllowedModules] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const navListRef = useRef(null);
  const activeTabRef = useRef(null);
  const tabReadyRef = useRef(false);

  useEffect(() => {
    Promise.resolve().then(() => {
      setMounted(true);

      const storedUser = localStorage.getItem("userName");
      if (storedUser) setUserName(storedUser);
      const storedRole = localStorage.getItem("userRole");
      if (storedRole) setUserRole(storedRole);
      try {
        const storedMods = JSON.parse(localStorage.getItem("userModules") || "[]");
        if (Array.isArray(storedMods)) setAllowedModules(storedMods);
      } catch { /* ignore */ }

      const savedCollapse = localStorage.getItem("sidebar_collapsed") === "true";
      if (savedCollapse) setIsCollapsed(true);
    });
  }, []);

  useEffect(() => {
    if (!mounted) return;
    fetchWithAuth("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.user) return;
        const name = data.user.fullName || data.user.username;
        if (name) {
          setUserName(name);
          localStorage.setItem("userName", name);
        }
        if (data.user.role) {
          setUserRole(data.user.role);
          localStorage.setItem("userRole", data.user.role);
        }
        const modules = Array.isArray(data.user.allowedModules) ? data.user.allowedModules : [];
        setAllowedModules(modules);
        storeAllowedModules(modules);
      })
      .catch(() => {});
  }, [mounted]);

  // Sync collapsed state with body class
  useEffect(() => {
    if (isCollapsed) {
      document.body.classList.add("sidebar-collapsed");
    } else {
      document.body.classList.remove("sidebar-collapsed");
    }
  }, [isCollapsed]);

  const toggleCollapse = () => {
    setIsCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("sidebar_collapsed", String(next));
      return next;
    });
  };

  const moveActiveTab = useCallback((animate) => {
    const list = navListRef.current;
    const tab = activeTabRef.current;
    if (!list || !tab) return;

    const active = list.querySelector(".sidebar-item.active");
    if (!active) {
      tab.classList.remove("is-visible");
      return;
    }

    const shouldAnimate = Boolean(animate && tabReadyRef.current);
    if (!shouldAnimate) {
      tab.classList.remove("is-ready");
    }

    tab.classList.add("is-visible");
    tab.style.transform = `translateY(${active.offsetTop}px)`;
    tab.style.height = `${active.offsetHeight}px`;

    if (!tabReadyRef.current) {
      tabReadyRef.current = true;
      requestAnimationFrame(() => tab.classList.add("is-ready"));
      return;
    }

    if (!shouldAnimate) {
      void tab.offsetHeight;
      tab.classList.add("is-ready");
    }
  }, []);

  useLayoutEffect(() => {
    if (!mounted) return;
    moveActiveTab(true);
  }, [mounted, pathname, isCollapsed, isOpen, userRole, allowedModules, moveActiveTab]);

  useEffect(() => {
    const list = navListRef.current;
    const sidebar = document.getElementById("main-sidebar");
    if (!list) return;

    const onResize = () => moveActiveTab(false);
    const ro = new ResizeObserver(onResize);
    ro.observe(list);
    window.addEventListener("resize", onResize);

    const onSidebarTransition = (event) => {
      if (event.propertyName === "width") moveActiveTab(false);
    };
    sidebar?.addEventListener("transitionend", onSidebarTransition);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      sidebar?.removeEventListener("transitionend", onSidebarTransition);
    };
  }, [moveActiveTab]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  const accessUser = { role: userRole, allowedModules };
  const navItems = [
    { name: "Inventory", href: "/dashboard", icon: <IconInventory />, tourId: "nav-inventory", moduleId: "inventory" },
    { name: "Stock Items", href: "/stock-items", icon: <IconStock />, tourId: "nav-stock", moduleId: "stock-items" },
    { name: "Purchase Orders", href: "/purchase-orders", icon: <IconPO />, tourId: "nav-po", moduleId: "purchase-orders" },
    { name: "Incoming PO", href: "/incoming-po", icon: <IconPO />, moduleId: "incoming-po" },
    { name: "Suppliers", href: "/suppliers", icon: <IconTruck />, moduleId: "suppliers" },
    { name: "Replenishment", href: "/replenishment", icon: <IconSparkles />, moduleId: "replenishment" },
    { name: "Forecast Generator", href: "/forecast-generator", icon: <IconForecast />, moduleId: FORECAST_MODULE },
    { name: "Last 3 Months Sales", href: "/sales", icon: <IconSales />, moduleId: "sales" },
    { name: "Syncing Center", href: "/syncing", icon: <IconSync />, tourId: "nav-sync", moduleId: "syncing" },
    ...(userRole === "admin"
      ? [{ name: "Admin", href: "/admin", icon: <IconAdmin />, moduleId: "admin" }]
      : []),
  ].filter((item) => userRole === "admin" || userCanAccessModule(accessUser, item.moduleId));

  return (
    <>
      <button
        className={`sidebar-mobile-toggle ${isOpen ? "is-hidden" : ""}`}
        onClick={() => setIsOpen(true)}
        aria-label="Open Menu"
        aria-expanded={isOpen}
        aria-controls="main-sidebar"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {isOpen && (
        <button
          className="sidebar-overlay"
          onClick={() => setIsOpen(false)}
          aria-label="Close Sidebar"
          type="button"
        />
      )}

      <aside id="main-sidebar" className={`sidebar ${isOpen ? "open" : ""} ${isCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          {/* Mobile Close Button */}
          <button
            className="sidebar-close-mobile"
            onClick={() => setIsOpen(false)}
            aria-label="Close Sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <div className="sidebar-brand">
            <span className="sidebar-logo">
              <img src="https://kelin-website.vercel.app/KELIN-LOGO-01.png" alt="KGS Logo" style={{ width: '38px', marginLeft: '4px' }} />
            </span>
            {!isCollapsed && <span>KGS PURCHASE</span>}
          </div>
          
          {/* Theme Toggle — Header Utility */}
          <div className="sidebar-utility">
            {themeMounted && (
              <button
                className={`theme-switch ${isDarkMode ? "dark" : "light"}`}
                onClick={toggleTheme}
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                <div className="theme-switch-track">
                  <div className="theme-switch-thumb">
                    {isDarkMode ? <IconMoon /> : <IconSun />}
                  </div>
                </div>
                {!isCollapsed && <span className="theme-switch-label">{isDarkMode ? "Dark Mode" : "Light Mode"}</span>}
              </button>
            )}
          </div>

          <div className="sidebar-session-wrap">
            <SessionStatus collapsed={isCollapsed} userName={userName} isAdmin={userRole === "admin"} />
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-nav-list" ref={navListRef}>
            <span className="sidebar-active-tab" ref={activeTabRef} aria-hidden="true" />
            {navItems.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className={`sidebar-item ${mounted && pathname === item.href ? "active" : ""}`}
                title={isCollapsed ? item.name : ""}
                data-tour={item.tourId || undefined}
              >
                <span className="sidebar-item-icon">{item.icon}</span>
                {!isCollapsed && <span>{item.name}</span>}
              </Link>
            ))}
          </div>
        </nav>

        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapse}
          aria-label={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          suppressHydrationWarning
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isCollapsed ? (
              <>
                <polyline points="13 17 18 12 13 7" />
                <line x1="6" y1="17" x2="11" y2="12" />
                <line x1="6" y1="7" x2="11" y2="12" />
              </>
            ) : (
              <>
                <polyline points="11 17 6 12 11 7" />
                <line x1="18" y1="17" x2="13" y2="12" />
                <line x1="18" y1="7" x2="13" y2="12" />
              </>
            )}
          </svg>
        </button>

        <AutoSyncIndicator collapsed={isCollapsed} />

        <div className="sidebar-footer">
          <div className="sidebar-version" title={`System version ${APP_VERSION}`}>
            v{APP_VERSION}
          </div>
          <Link
            href="/account"
            className={`sidebar-item sidebar-account ${pathname === "/account" ? "active" : ""}`}
            title={isCollapsed ? "Account" : ""}
            data-tour="nav-account"
          >
            <span className="sidebar-item-icon">
              <IconAccount />
            </span>
            {!isCollapsed && <span>Account</span>}
          </Link>
          <button
            className="sidebar-logout"
            onClick={() => {
              localStorage.removeItem("acu_session");
              localStorage.removeItem("userName");
              localStorage.removeItem("userFirstName");
              localStorage.removeItem("userLastName");
              localStorage.removeItem("userRole");
              localStorage.removeItem("authType");
              localStorage.removeItem("activeCompanyId");

              Object.keys(localStorage)
                .filter((k) => k.includes("_filter_") || k.startsWith("acu_data_"))
                .forEach((k) => localStorage.removeItem(k));

              DataCache.clear();
              window.location.href = withBasePath("/api/auth/logout");
            }}
            title={isCollapsed ? "Logout" : ""}
          >
            <span className="sidebar-item-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            {!isCollapsed && <span>Logout</span>}
          </button>
        </div>
      </aside>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(1.4); }
        }
      `}</style>
      <TourGuide />
    </>
  );
}
