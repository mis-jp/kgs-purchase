"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchWithAuth } from "@/lib/api-client";
import "@/styles/admin.css";

const EMPTY_FORM = {
    username: "",
    password: "",
    fullName: "",
    email: "",
    role: "user",
    active: true,
    branchIds: [],
    moduleAccess: "all",
};

export default function AdminPage() {
    const router = useRouter();
    const [me, setMe] = useState(null);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [form, setForm] = useState(EMPTY_FORM);
    const [editingId, setEditingId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [profile, setProfile] = useState({ username: "", fullName: "", email: "" });
    const [savingProfile, setSavingProfile] = useState(false);
    const [branchOptions, setBranchOptions] = useState([]);
    const [salesMonths, setSalesMonths] = useState("3");
    const [salesUnit, setSalesUnit] = useState("months");
    const [savingWindow, setSavingWindow] = useState(false);
    const [branchMenuOpen, setBranchMenuOpen] = useState(false);
    const [branchQuery, setBranchQuery] = useState("");
    const branchPickerRef = useRef(null);

    const branchLabel = (b) => (b?.name && b.name !== b.id ? `${b.id} — ${b.name}` : (b?.id || ""));

    const selectedBranchSet = useMemo(() => {
        return new Set((form.branchIds || []).map((id) => String(id).toUpperCase()));
    }, [form.branchIds]);

    const filteredBranchOptions = useMemo(() => {
        const q = branchQuery.trim().toLowerCase();
        if (!q) return branchOptions;
        return branchOptions.filter((b) => {
            const label = `${b.id} ${b.name || ""}`.toLowerCase();
            return label.includes(q);
        });
    }, [branchOptions, branchQuery]);

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [sessionRes, usersRes, branchesRes, windowRes] = await Promise.all([
                fetchWithAuth("/api/auth/session"),
                fetchWithAuth("/api/admin/users"),
                fetchWithAuth("/api/branches"),
                fetchWithAuth("/api/admin/replenishment-window"),
            ]);

            if (sessionRes.status === 401) {
                router.replace("/signin?expired=1");
                return;
            }
            const sessionData = await sessionRes.json();
            if (!sessionData?.user || sessionData.user.role !== "admin") {
                router.replace("/dashboard");
                return;
            }
            if (windowRes.ok) {
                const windowData = await windowRes.json();
                if (windowData?.value || windowData?.months) {
                    setSalesMonths(String(windowData.value ?? windowData.months));
                    setSalesUnit(windowData.unit === "days" ? "days" : "months");
                }
            }
            setMe(sessionData.user);
            setProfile({
                username: sessionData.user.username || "",
                fullName: sessionData.user.fullName || "",
                email: sessionData.user.email || "",
            });

            if (!usersRes.ok) {
                const body = await usersRes.json().catch(() => ({}));
                throw new Error(body.message || "Failed to load users");
            }
            const data = await usersRes.json();
            setUsers(data.users || []);
            if (branchesRes.ok) {
                const branchData = await branchesRes.json();
                const list = Array.isArray(branchData) ? branchData : (branchData?.value || []);
                setBranchOptions(
                    list
                        .map((b) => ({
                            id: String(b.SiteID || b.branch_id || "").trim(),
                            name: String(b.Description?.value || b.Description || b.branch_name || b.SiteID || "").trim(),
                        }))
                        .filter((b) => b.id)
                );
            }
        } catch (err) {
            setError(err.message || "Failed to load admin data");
        } finally {
            setLoading(false);
        }
    }, [router]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (!branchMenuOpen) return undefined;
        const onDoc = (e) => {
            if (!branchPickerRef.current?.contains(e.target)) {
                setBranchMenuOpen(false);
            }
        };
        const onKey = (e) => {
            if (e.key === "Escape") setBranchMenuOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [branchMenuOpen]);

    const resetForm = () => {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setBranchMenuOpen(false);
        setBranchQuery("");
    };

    const toggleBranch = (branchId) => {
        setForm((f) => {
            const current = f.branchIds || [];
            const exists = current.some((id) => String(id).toUpperCase() === String(branchId).toUpperCase());
            if (exists) {
                return {
                    ...f,
                    branchIds: current.filter((id) => String(id).toUpperCase() !== String(branchId).toUpperCase()),
                };
            }
            return { ...f, branchIds: [...current, branchId] };
        });
    };

    const startEdit = (user) => {
        setEditingId(user.id);
        setForm({
            username: user.username || "",
            password: "",
            fullName: user.fullName || "",
            email: user.email || "",
            role: user.role || "user",
            active: user.active !== false,
            branchIds: Array.isArray(user.branchIds) ? user.branchIds : [],
            moduleAccess: Array.isArray(user.allowedModules) && user.allowedModules.includes("forecast-generator")
                ? "forecast-generator"
                : "all",
        });
        setBranchMenuOpen(false);
        setBranchQuery("");
        setNotice("");
        setError("");
    };

    const handleSaveUser = async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        setNotice("");
        try {
            if (form.role === "user" && !(form.branchIds || []).length) {
                throw new Error("Select at least one branch for this user.");
            }
            const payload = {
                username: form.username,
                fullName: form.fullName,
                email: form.email,
                role: form.role,
                active: form.active,
                branchIds: form.role === "admin" ? [] : form.branchIds,
                moduleAccess: form.role === "admin" ? "all" : form.moduleAccess,
            };
            if (form.password) payload.password = form.password;

            let res;
            if (editingId) {
                res = await fetchWithAuth(`/api/admin/users/${editingId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } else {
                if (!form.password) throw new Error("Password is required for new users.");
                payload.password = form.password;
                res = await fetchWithAuth("/api/admin/users", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "Save failed");

            setNotice(editingId ? "User updated." : "User created.");
            resetForm();
            await load();
            if (data.user?.id === me?.id) {
                localStorage.setItem("userName", data.user.fullName || data.user.username);
                localStorage.setItem("userRole", data.user.role);
            }
        } catch (err) {
            setError(err.message || "Save failed");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (user) => {
        if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
        setError("");
        setNotice("");
        try {
            const res = await fetchWithAuth(`/api/admin/users/${user.id}`, { method: "DELETE" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "Delete failed");
            setNotice(`Deleted ${user.username}.`);
            if (editingId === user.id) resetForm();
            await load();
        } catch (err) {
            setError(err.message || "Delete failed");
        }
    };

    const handleSaveProfile = async (e) => {
        e.preventDefault();
        setSavingProfile(true);
        setError("");
        setNotice("");
        try {
            const payload = {
                username: profile.username,
                fullName: profile.fullName,
                email: profile.email,
            };
            const res = await fetchWithAuth("/api/auth/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "Profile update failed");
            setNotice("Your profile was updated.");
            localStorage.setItem("userName", data.user.fullName || data.user.username);
            localStorage.setItem("userRole", data.user.role);
            setMe(data.user);
            await load();
        } catch (err) {
            setError(err.message || "Profile update failed");
        } finally {
            setSavingProfile(false);
        }
    };

    const handleSaveSalesWindow = async (event) => {
        event.preventDefault();
        setSavingWindow(true);
        setError("");
        setNotice("");
        try {
            const res = await fetchWithAuth("/api/admin/replenishment-window", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: Number(salesMonths), unit: salesUnit }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "Failed to update the sales window");
            setSalesMonths(String(data.value ?? data.months ?? salesMonths));
            setSalesUnit(data.unit === "days" ? "days" : "months");
            setNotice(data.message || "Replenishment sales window updated.");
        } catch (err) {
            setError(err.message || "Failed to update the sales window");
        } finally {
            setSavingWindow(false);
        }
    };

    if (loading) {
        return (
            <div className="admin-root">
                <div className="admin-loading">Loading admin…</div>
            </div>
        );
    }

    return (
        <div className="admin-root">
            <header className="admin-header" data-tour="page-title">
                <div>
                    <h1>Admin — User Accounts</h1>
                    <p>Create and manage local logins for KGS Purchasing. ERP data still uses system Acumatica credentials.</p>
                </div>
            </header>

            {error && <div className="admin-alert admin-alert--error" role="alert">{error}</div>}
            {notice && <div className="admin-alert admin-alert--ok" role="status">{notice}</div>}

            <section className="admin-card">
                <h2>Replenishment sales window</h2>
                <p className="admin-header-hint">
                    Sells per day, days left, and order quantity use this sales window for every branch.
                    The default is 3 months. Choose days or months, then save to recalculate Replenishment.
                </p>
                <form className="admin-form" onSubmit={handleSaveSalesWindow}>
                    <div className="admin-form-grid">
                        <label>
                            Amount
                            <input
                                type="number"
                                min={1}
                                max={salesUnit === "days" ? 720 : 24}
                                step={1}
                                value={salesMonths}
                                onChange={(e) => setSalesMonths(e.target.value)}
                                required
                            />
                        </label>
                        <label>
                            Unit
                            <select value={salesUnit} onChange={(e) => setSalesUnit(e.target.value === "days" ? "days" : "months")}>
                                <option value="months">Months</option>
                                <option value="days">Days</option>
                            </select>
                        </label>
                    </div>
                    <button type="submit" className="admin-btn" disabled={savingWindow}>
                        {savingWindow ? "Updating…" : "Update all branches"}
                    </button>
                </form>
            </section>

            <section className="admin-card">
                <h2>My account</h2>
                <p className="admin-header-hint">
                    To change your password, open{" "}
                    <Link href="/account">Account</Link> in the sidebar.
                </p>
                <form className="admin-form" onSubmit={handleSaveProfile}>
                    <div className="admin-form-grid">
                        <label>
                            Username
                            <input
                                value={profile.username}
                                onChange={(e) => setProfile((p) => ({ ...p, username: e.target.value }))}
                                required
                                autoComplete="username"
                            />
                        </label>
                        <label>
                            Full name
                            <input
                                value={profile.fullName}
                                onChange={(e) => setProfile((p) => ({ ...p, fullName: e.target.value }))}
                            />
                        </label>
                        <label>
                            Email
                            <input
                                type="email"
                                value={profile.email}
                                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
                            />
                        </label>
                    </div>
                    <button type="submit" className="admin-btn" disabled={savingProfile}>
                        {savingProfile ? "Saving…" : "Save my account"}
                    </button>
                </form>
            </section>

            <section className="admin-card" data-tour="toolbar">
                <div className="admin-card-head">
                    <h2>{editingId ? "Edit user" : "Create user"}</h2>
                    {editingId && (
                        <button type="button" className="admin-btn admin-btn--ghost" onClick={resetForm}>
                            Cancel edit
                        </button>
                    )}
                </div>
                <form className="admin-form" onSubmit={handleSaveUser}>
                    <div className="admin-form-grid">
                        <label>
                            Username
                            <input
                                value={form.username}
                                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                                required
                            />
                        </label>
                        <label>
                            Password {editingId ? "(optional)" : ""}
                            <input
                                type="password"
                                value={form.password}
                                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                                placeholder={editingId ? "Leave blank to keep" : "Min 8 characters"}
                                required={!editingId}
                                autoComplete="new-password"
                            />
                        </label>
                        <label>
                            Full name
                            <input
                                value={form.fullName}
                                onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                            />
                        </label>
                        <label>
                            Email
                            <input
                                type="email"
                                value={form.email}
                                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                            />
                        </label>
                        <label>
                            Role
                            <select
                                value={form.role}
                                onChange={(e) => {
                                    const role = e.target.value;
                                    setForm((f) => ({
                                        ...f,
                                        role,
                                        moduleAccess: role === "admin" ? "all" : f.moduleAccess,
                                    }));
                                    if (role === "admin") {
                                        setBranchMenuOpen(false);
                                        setBranchQuery("");
                                    }
                                }}
                            >
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                            </select>
                        </label>
                        <label>
                            Module access
                            <select
                                value={form.role === "admin" ? "all" : form.moduleAccess}
                                disabled={form.role === "admin"}
                                onChange={(e) => setForm((f) => ({ ...f, moduleAccess: e.target.value }))}
                            >
                                <option value="all">All modules</option>
                                <option value="forecast-generator">Forecast Generator only</option>
                            </select>
                        </label>
                        <label className="admin-check">
                            <input
                                type="checkbox"
                                checked={form.active}
                                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                            />
                            Active
                        </label>
                    </div>
                    <div className="admin-branch-picker" ref={branchPickerRef}>
                        <div className="admin-branch-picker-head">
                            <span>Branch access</span>
                            {form.role === "user" && (
                                <span className="admin-branch-picker-actions">
                                    <button
                                        type="button"
                                        className="admin-link"
                                        onClick={() => setForm((f) => ({ ...f, branchIds: branchOptions.map((b) => b.id) }))}
                                    >
                                        Select all
                                    </button>
                                    <button
                                        type="button"
                                        className="admin-link"
                                        onClick={() => setForm((f) => ({ ...f, branchIds: [] }))}
                                    >
                                        Clear
                                    </button>
                                </span>
                            )}
                        </div>
                        {form.role === "admin" ? (
                            <p className="admin-header-hint">Admins can view all branches and modules. Limits apply to User accounts only.</p>
                        ) : (
                            <>
                                {form.moduleAccess === "forecast-generator" && (
                                    <p className="admin-header-hint">This account can open Forecast Generator only. Choose the branches they may plan for.</p>
                                )}
                                <button
                                    type="button"
                                    className={`admin-branch-trigger${branchMenuOpen ? " is-open" : ""}`}
                                    onClick={() => setBranchMenuOpen((o) => !o)}
                                    aria-haspopup="listbox"
                                    aria-expanded={branchMenuOpen}
                                >
                                    <span>
                                        {form.branchIds.length === 0
                                            ? "Select branches…"
                                            : form.branchIds.length === 1
                                                ? (branchLabel(branchOptions.find((b) => String(b.id).toUpperCase() === String(form.branchIds[0]).toUpperCase())) || form.branchIds[0])
                                                : `${form.branchIds.length} branches selected`}
                                    </span>
                                    <span className="admin-branch-chevron" aria-hidden="true" />
                                </button>
                                {branchMenuOpen && (
                                    <div className="admin-branch-menu" role="listbox" aria-multiselectable="true">
                                        <input
                                            className="admin-branch-search"
                                            type="search"
                                            value={branchQuery}
                                            onChange={(e) => setBranchQuery(e.target.value)}
                                            placeholder="Search branch…"
                                            autoFocus
                                        />
                                        <div className="admin-branch-menu-list">
                                            {filteredBranchOptions.length === 0 ? (
                                                <p className="admin-header-hint">No branches found.</p>
                                            ) : (
                                                filteredBranchOptions.map((b) => {
                                                    const checked = selectedBranchSet.has(String(b.id).toUpperCase());
                                                    return (
                                                        <label key={b.id} className={`admin-branch-option${checked ? " is-selected" : ""}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={checked}
                                                                onChange={() => toggleBranch(b.id)}
                                                            />
                                                            <span>{branchLabel(b)}</span>
                                                        </label>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>
                                )}
                                {form.branchIds.length > 0 && (
                                    <div className="admin-branch-chips">
                                        {form.branchIds.map((id) => {
                                            const opt = branchOptions.find((b) => String(b.id).toUpperCase() === String(id).toUpperCase());
                                            return (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    className="admin-branch-chip"
                                                    onClick={() => toggleBranch(id)}
                                                    title="Remove branch"
                                                >
                                                    {opt ? branchLabel(opt) : id}
                                                    <span aria-hidden="true">×</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    <button type="submit" className="admin-btn" disabled={saving}>
                        {saving ? "Saving…" : editingId ? "Update user" : "Create user"}
                    </button>
                </form>
            </section>

            <section className="admin-card" data-tour="main-table">
                <h2>All users ({users.length})</h2>
                <div className="admin-table-wrap">
                    <table className="admin-table">
                        <thead>
                            <tr>
                                <th>Username</th>
                                <th>Name</th>
                                <th>Email</th>
                                <th>Role</th>
                                <th>Modules</th>
                                <th>Branches</th>
                                <th>Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="admin-empty">No users yet.</td>
                                </tr>
                            ) : (
                                users.map((u) => {
                                    const isSelf = Number(u.id) === Number(me?.id);
                                    return (
                                    <tr key={u.id}>
                                        <td>
                                            {u.username}
                                            {isSelf ? <span className="admin-you"> (you)</span> : null}
                                        </td>
                                        <td>{u.fullName || "—"}</td>
                                        <td>{u.email || "—"}</td>
                                        <td>
                                            <span className={`admin-badge admin-badge--${u.role}`}>{u.role}</span>
                                        </td>
                                        <td>
                                            {u.role === "admin" || !(u.allowedModules || []).length ? (
                                                <span>All modules</span>
                                            ) : (
                                                <span className="admin-badge admin-badge--forecast">Forecast Generator</span>
                                            )}
                                        </td>
                                        <td className="admin-branches-cell">
                                            {u.role === "admin" || u.allBranches
                                                ? "All branches"
                                                : (u.branchIds || []).length
                                                    ? (u.branchIds || []).join(", ")
                                                    : "None"}
                                        </td>
                                        <td>{u.active ? "Active" : "Inactive"}</td>
                                        <td className="admin-actions">
                                            <button type="button" className="admin-link" onClick={() => startEdit(u)}>
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                className="admin-link admin-link--danger"
                                                onClick={() => handleDelete(u)}
                                                disabled={isSelf}
                                                title={
                                                    isSelf
                                                        ? "You cannot delete your own account"
                                                        : `Delete ${u.username}`
                                                }
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
