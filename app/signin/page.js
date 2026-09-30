"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import "@/styles/signin.css";
import { withBasePath } from "@/lib/base-path";
import { homePathForUser } from "@/lib/module-access";

const LOGIN_API = withBasePath("/api/auth/login");

/* ── SVG Icons ─────────────────────────────────────────── */
const IconUser = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
);

const IconLock = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
);

const IconEye = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const IconEyeOff = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

const IconAlert = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
);

/* ── Component ──────────────────────────────────────────── */
function SignInContent() {
    const searchParams = useSearchParams();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    // Avoid hydration mismatches from browser extensions that inject attrs
    // (e.g. fdprocessedid) onto form controls before React hydrates.
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        if (!mounted) return;
        if (searchParams.get("expired") === "1") {
            localStorage.removeItem("acu_session");
            setError("Your session has expired. Please log in again.");
        }
    }, [mounted, searchParams]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");

        if (!username || !password) {
            setError("Please fill in all fields.");
            return;
        }

        setLoading(true);
        try {
            const res = await fetch(LOGIN_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ username, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data?.message || "Invalid credentials. Please try again.");
                return;
            }

            const { sessionId, user } = data;
            if (sessionId) {
                localStorage.setItem("acu_session", sessionId);
            }

            const displayName = user?.fullName || user?.username || username;
            localStorage.setItem("userName", displayName);
            localStorage.setItem("userRole", user?.role || "user");
            localStorage.setItem("authType", "local");
            localStorage.setItem("userModules", JSON.stringify(Array.isArray(user?.allowedModules) ? user.allowedModules : []));
            localStorage.removeItem("userFirstName");
            localStorage.removeItem("userLastName");

            window.location.href = withBasePath(homePathForUser(user));
        } catch (err) {
            setError("Unable to connect to the server. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="signin-wrapper">
            <div className="signin-bg" aria-hidden="true">
                <div className="signin-orb signin-orb--a" />
                <div className="signin-orb signin-orb--b" />
                <div className="signin-orb signin-orb--c" />
                <div className="signin-bg-grid" />
                <div className="signin-bg-ring signin-bg-ring--1" />
                <div className="signin-bg-ring signin-bg-ring--2" />
                <div className="signin-bg-panel signin-bg-panel--1" />
                <div className="signin-bg-panel signin-bg-panel--2" />
                <div className="signin-bg-panel signin-bg-panel--3" />
                <div className="signin-bg-beam signin-bg-beam--1" />
                <div className="signin-bg-beam signin-bg-beam--2" />
            </div>

            <div className="signin-stage">
                <div className="signin-underlay" aria-hidden="true">
                    <span className="signin-underlay-blob signin-underlay-blob--a" />
                    <span className="signin-underlay-blob signin-underlay-blob--b" />
                    <span className="signin-underlay-blob signin-underlay-blob--c" />
                    <span className="signin-underlay-shape signin-underlay-shape--1" />
                    <span className="signin-underlay-shape signin-underlay-shape--2" />
                    <span className="signin-underlay-shape signin-underlay-shape--3" />
                    <span className="signin-underlay-stripe" />
                </div>
            <div className="signin-card">
                <div className="signin-header">
                    <div className="signin-logo-container">
                        <img
                            src={withBasePath("/kelin-logo.png")}
                            alt="Kelin Graphics System"
                            className="signin-logo-img"
                            width={180}
                            height={92}
                            decoding="async"
                            fetchPriority="high"
                        />
                    </div>
                    <h1 className="signin-title">KGS PURCHASING</h1>
                    <p className="signin-subtitle">Sign in with your account details</p>
                </div>

                {!mounted ? (
                    <div className="signin-form signin-form-skeleton" aria-hidden="true">
                        <div className="signin-field">
                            <div className="signin-label">Username</div>
                            <div className="signin-input-wrapper signin-skeleton-bar">
                                <span className="signin-input-icon"><IconUser /></span>
                                <span className="signin-skeleton-text">Username</span>
                            </div>
                        </div>
                        <div className="signin-field">
                            <div className="signin-label">Password</div>
                            <div className="signin-input-wrapper signin-skeleton-bar">
                                <span className="signin-input-icon"><IconLock /></span>
                                <span className="signin-skeleton-text">Password</span>
                            </div>
                        </div>
                        <div className="signin-btn signin-skeleton-btn">Sign In</div>
                    </div>
                ) : (
                    <form className="signin-form" onSubmit={handleSubmit} noValidate>
                        {error && (
                            <div className="signin-error" role="alert">
                                <IconAlert />
                                <span>{error}</span>
                            </div>
                        )}

                        <div className="signin-field">
                            <label className="signin-label" htmlFor="username">
                                Username
                            </label>
                            <div className="signin-input-wrapper">
                                <span className="signin-input-icon" aria-hidden="true"><IconUser /></span>
                                <input
                                    id="username"
                                    name="username"
                                    className="signin-input"
                                    type="text"
                                    placeholder="Enter your username"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    autoComplete="username"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    enterKeyHint="next"
                                    required
                                />
                            </div>
                        </div>

                        <div className="signin-field">
                            <label className="signin-label" htmlFor="current-password">
                                Password
                            </label>
                            <div className="signin-input-wrapper">
                                <span className="signin-input-icon" aria-hidden="true"><IconLock /></span>
                                <input
                                    id="current-password"
                                    name="password"
                                    className="signin-input"
                                    type={showPassword ? "text" : "password"}
                                    placeholder="Enter your password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    autoComplete="current-password"
                                    enterKeyHint="done"
                                    required
                                />
                                <button
                                    type="button"
                                    className="signin-toggle-password"
                                    onClick={() => setShowPassword(!showPassword)}
                                    aria-label={showPassword ? "Hide password" : "Show password"}
                                    aria-pressed={showPassword}
                                >
                                    {showPassword ? <IconEyeOff /> : <IconEye />}
                                </button>
                            </div>
                        </div>

                        <div className="signin-options">
                            <div className="signin-remember">
                                <input
                                    id="remember"
                                    name="remember"
                                    className="signin-checkbox"
                                    type="checkbox"
                                />
                                <label htmlFor="remember" className="signin-remember-label">
                                    Remember me
                                </label>
                            </div>
                            <button
                                type="button"
                                className="signin-forgot-btn"
                                onClick={() => alert("Please contact your administrator to reset your password.")}
                            >
                                Forgot password?
                            </button>
                        </div>

                        <button type="submit" className="signin-btn" disabled={loading}>
                            {loading ? <span className="signin-spinner" aria-label="Signing in" /> : "Sign In"}
                        </button>
                    </form>
                )}

                <div className="signin-footer">
                    <p suppressHydrationWarning>&copy; {new Date().getFullYear()} Kelin Graphics System Corp.</p>
                </div>
            </div>
            </div>
        </div>
    );
}

export default function SignInPage() {
    return (
        <Suspense fallback={null}>
            <SignInContent />
        </Suspense>
    );
}
