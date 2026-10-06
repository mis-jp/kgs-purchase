"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/base-path";
import TourGuide from "@/components/TourGuide";
import "@/styles/sync.css";

const IconSync = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
    </svg>
);

const IconZap = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

const IconCheck = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const IconAlert = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
);

const IconChevronLeft = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6" />
    </svg>
);

async function waitForActiveSyncToFinish(timeoutMs = 120000, pollMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const statusRes = await fetch("/api/sync?status=1", { cache: "no-store" });
            if (statusRes.ok) {
                const status = await statusRes.json();
                if (!status?.running) return true;
            }
        } catch {
            /* ignore transient polling errors */
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
}

function formatMode(mode) {
    if (mode === "incremental" || mode === "delta" || mode === "quick") return "Quick";
    if (mode === "full") return "Full";
    if (mode === "import") return "Import";
    return mode || "—";
}

function statusClass(status) {
    if (status === "completed") return "is-ok";
    if (status === "started") return "is-run";
    return "is-err";
}

const IconUpload = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
);

export default function SyncingClient() {
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncMode, setSyncMode] = useState(null);
    const [sections, setSections] = useState({});
    const [overallProgress, setOverallProgress] = useState(0);
    const [complete, setComplete] = useState(false);
    const [error, setError] = useState(null);
    const [logs, setLogs] = useState([]);
    const [history, setHistory] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [importFile, setImportFile] = useState(null);
    const [importType, setImportType] = useState("inventory");
    const [showImport, setShowImport] = useState(false);
    const [importDragOver, setImportDragOver] = useState(false);
    const [importError, setImportError] = useState(null);
    const [activeSync, setActiveSync] = useState({ running: false, section: "", mode: "" });
    const logsEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const dragDepthRef = useRef(0);

    const IMPORT_ACCEPT =
        ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";

    const isAllowedImportFile = (file) => {
        if (!file) return false;
        const name = String(file.name || "").toLowerCase();
        return (
            name.endsWith(".xlsx") ||
            name.endsWith(".xls") ||
            name.endsWith(".csv") ||
            /spreadsheet|excel|csv/i.test(String(file.type || ""))
        );
    };

    const pickImportFile = (file) => {
        if (!file) return;
        if (!isAllowedImportFile(file)) {
            setImportError("Please use an Excel (.xlsx, .xls) or CSV file.");
            return;
        }
        setImportError(null);
        setImportFile(file);
    };

    const addLog = (msg) => {
        setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    const fetchHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            const res = await fetch("/api/sync");
            if (res.ok) {
                const data = await res.json();
                setHistory(data || []);
            }
        } catch (err) {
            console.error("Failed to fetch sync history", err);
        } finally {
            setLoadingHistory(false);
        }
    }, []);

    useEffect(() => {
        fetchHistory();
    }, [fetchHistory]);

    useEffect(() => {
        let cancelled = false;
        let timer = null;

        const pollStatus = async () => {
            try {
                const res = await fetch("/api/sync?status=1", { cache: "no-store" });
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (cancelled) return;
                setActiveSync({
                    running: Boolean(data?.running),
                    section: data?.section || "",
                    mode: data?.mode || "",
                });
            } catch {
                /* ignore transient errors */
            }
        };

        pollStatus();
        timer = setInterval(pollStatus, 5000);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs]);

    const resetToChooser = () => {
        setComplete(false);
        setError(null);
        setSections({});
        setOverallProgress(0);
        setLogs([]);
        setSyncMode(null);
        setShowImport(false);
        setImportFile(null);
        setImportType("inventory");
        setImportDragOver(false);
        setImportError(null);
        dragDepthRef.current = 0;
    };

    const startImport = async () => {
        if (isSyncing || !importFile) return;

        const typeLabel =
            importType === "purchase-receipts" ? "Purchase Receipts" : "Stock Items";
        const sectionName =
            importType === "purchase-receipts" ? "Purchase Receipts" : "Inventory";

        setIsSyncing(true);
        setSyncMode("import");
        setShowImport(false);
        setComplete(false);
        setError(null);
        setSections({
            [sectionName]: {
                status: "run",
                details: `Uploading ${importFile.name}…`,
                progress: 15,
                count: 0,
            },
        });
        setOverallProgress(15);
        setLogs([]);
        addLog(`Importing ${typeLabel}: ${importFile.name}`);

        try {
            const form = new FormData();
            form.append("file", importFile);
            form.append("importType", importType);
            const res = await fetch("/api/sync/import", { method: "POST", body: form });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || `Import failed (${res.status})`);

            const count =
                importType === "purchase-receipts"
                    ? data.receipts || 0
                    : data.catalogs || 0;

            setSections({
                [sectionName]: {
                    status: "done",
                    details: data.message,
                    progress: 100,
                    count,
                },
            });
            setOverallProgress(100);
            setComplete(true);
            addLog(data.message || "Import completed.");
            if (data.detected?.columns) {
                addLog(`Detected columns: ${data.detected.columns.join(", ")}`);
            }
            fetchHistory();
        } catch (err) {
            setError(err.message);
            addLog(`ERROR: ${err.message}`);
            fetchHistory();
        } finally {
            setIsSyncing(false);
            setImportFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const startSync = async (mode) => {
        if (isSyncing) return;

        setIsSyncing(true);
        setSyncMode(mode);
        setComplete(false);
        setError(null);
        setSections({});
        setOverallProgress(0);
        setLogs([]);
        addLog(`Starting ${mode === "full" ? "Full" : "Quick"} Sync…`);

        try {
            const apiMode = mode === "full" ? "full" : "incremental";
            const queryParams = new URLSearchParams({
                inventory: "true",
                sales: "true",
                mode: apiMode,
            });

            let res = await fetch(`/api/sync?${queryParams.toString()}`, { method: "POST" });
            if (res.status === 409) {
                addLog("Another sync is already running. Waiting for it to finish...");
                const freed = await waitForActiveSyncToFinish();
                if (freed) {
                    addLog("Previous sync finished. Retrying now...");
                    res = await fetch(`/api/sync?${queryParams.toString()}`, { method: "POST" });
                }
            }
            if (!res.ok) {
                let errorMsg = `Sync failed with status ${res.status}`;
                try {
                    const errData = await res.json();
                    errorMsg = errData.message || errData.error || errorMsg;
                } catch {
                    /* ignore */
                }
                throw new Error(errorMsg);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.ping) continue;

                        if (data.section) {
                            setSections((prev) => {
                                const previous = prev[data.section] || {};
                                const nextProgress = Number.isFinite(Number(data.progress))
                                    ? Number(data.progress)
                                    : (previous.progress || 0);
                                const next = {
                                    ...prev,
                                    [data.section]: {
                                        status: data.status || previous.status,
                                        details: data.details || previous.details,
                                        progress: data.status === "done" ? 100 : nextProgress,
                                        count: data.count || previous.count || 0,
                                    },
                                };
                                const vals = Object.values(next);
                                if (vals.length > 0) {
                                    const total = vals.reduce((acc, s) => acc + (s.progress || 0), 0);
                                    setOverallProgress(Math.floor(total / vals.length));
                                }
                                return next;
                            });
                            if (data.details) addLog(data.details);
                        }

                        if (data.status === "complete") {
                            setComplete(true);
                            setOverallProgress(100);
                            addLog("Sync completed successfully!");
                            fetchHistory();
                        }

                        if (data.status === "error") {
                            setError(data.message);
                            addLog(`ERROR: ${data.message}`);
                            fetchHistory();
                        }
                    } catch (e) {
                        console.error("Failed to parse sync line", e);
                    }
                }
            }
        } catch (err) {
            setError(err.message);
            addLog(`CRITICAL ERROR: ${err.message}`);
        } finally {
            setIsSyncing(false);
        }
    };

    const idle = !isSyncing && !complete && !error;
    const sectionEntries = Object.entries(sections);

    return (
        <div className="sync-root">
            <TourGuide />
            <header className="sync-topbar">
                <div className="sync-topbar-brand">
                    <img
                        src={withBasePath("/kelin-logo.png")}
                        alt="KGS"
                        className="sync-topbar-logo"
                    />
                    <div>
                        <p className="sync-topbar-eyebrow">KGS Purchase</p>
                        <h1 className="sync-topbar-title">
                            Sync <span>Center</span>
                        </h1>
                    </div>
                </div>
                <div className="sync-topbar-meta">
                    <span className="sync-pill">Acumatica → MySQL</span>
                    {activeSync.running ? (
                        <span className="sync-pill sync-pill-running" title={`Sync in progress: ${activeSync.section || "Starting"}`}>
                            Sync running{activeSync.section ? `: ${activeSync.section}` : ""}
                        </span>
                    ) : null}
                    <Link href="/dashboard" className="sync-link-back">
                        <IconChevronLeft /> Dashboard
                    </Link>
                </div>
            </header>

            <main className="sync-shell">
                {idle ? (
                    <section className="sync-hero" aria-labelledby="sync-hero-title" data-tour="page-title">
                        <p className="sync-eyebrow">Data synchronization</p>
                        <h2 id="sync-hero-title" className="sync-hero-title">
                            Keep MySQL current with Acumatica
                        </h2>
                        <p className="sync-hero-copy">
                            Choose a sync mode. Quick pulls only new and changed records;
                            Full rebuilds from Acumatica online; Import loads an Excel/CSV
                            export when online Full Sync is unreliable.
                        </p>

                        <div className="sync-mode-grid" role="group" aria-label="Sync modes" data-tour="sync-modes">
                            <button
                                type="button"
                                className="sync-mode-card is-quick"
                                onClick={() => startSync("quick")}
                            >
                                <div className="sync-mode-icon" aria-hidden="true">
                                    <IconZap />
                                </div>
                                <div className="sync-mode-body">
                                    <div className="sync-mode-head">
                                        <span className="sync-mode-name">Quick Sync</span>
                                        <span className="sync-mode-badge">Recommended</span>
                                    </div>
                                    <p className="sync-mode-desc">
                                        Sync only new and changed records since the last run.
                                        Faster for daily updates — skips data MySQL already has.
                                    </p>
                                    <span className="sync-mode-cta">Start Quick Sync →</span>
                                </div>
                            </button>

                            <button
                                type="button"
                                className="sync-mode-card is-full"
                                onClick={() => startSync("full")}
                            >
                                <div className="sync-mode-icon" aria-hidden="true">
                                    <IconSync />
                                </div>
                                <div className="sync-mode-body">
                                    <div className="sync-mode-head">
                                        <span className="sync-mode-name">Full Sync</span>
                                        <span className="sync-mode-badge is-muted">Complete</span>
                                    </div>
                                    <p className="sync-mode-desc">
                                        Full inventory, stock levels, sales history, and related data.
                                        Use when you need a complete refresh or to fix accuracy.
                                    </p>
                                    <span className="sync-mode-cta">Start Full Sync →</span>
                                </div>
                            </button>

                            <button
                                type="button"
                                className="sync-mode-card is-import"
                                onClick={() => {
                                    setShowImport(true);
                                    setImportError(null);
                                }}
                            >
                                <div className="sync-mode-icon" aria-hidden="true">
                                    <IconUpload />
                                </div>
                                <div className="sync-mode-body">
                                    <div className="sync-mode-head">
                                        <span className="sync-mode-name">Import File</span>
                                        <span className="sync-mode-badge is-muted">Offline</span>
                                    </div>
                                    <p className="sync-mode-desc">
                                        Upload an Acumatica Excel/CSV — Stock Items / Inventory
                                        Summary, or Purchase Receipts list. Choose the target
                                        below before importing.
                                    </p>
                                    <span className="sync-mode-cta">Choose file →</span>
                                </div>
                            </button>
                        </div>

                        {showImport ? (
                            <div className="sync-import-panel" role="region" aria-label="Import Acumatica file">
                                <h3>Import Acumatica export</h3>
                                <p>
                                    Pick what this file contains, then select the Excel/CSV from
                                    Acumatica.
                                </p>

                                <div
                                    className="sync-import-type"
                                    role="radiogroup"
                                    aria-label="Import target"
                                >
                                    <label
                                        className={`sync-import-type-option ${
                                            importType === "inventory" ? "is-selected" : ""
                                        }`}
                                    >
                                        <input
                                            type="radio"
                                            name="importType"
                                            value="inventory"
                                            checked={importType === "inventory"}
                                            onChange={() => setImportType("inventory")}
                                        />
                                        <span className="sync-import-type-body">
                                            <strong>Stock Items / Inventory</strong>
                                            <span>
                                                Catalog and optional on-hand by warehouse
                                                (Inventory ID, Description, Item Class…).
                                            </span>
                                        </span>
                                    </label>
                                    <label
                                        className={`sync-import-type-option ${
                                            importType === "purchase-receipts" ? "is-selected" : ""
                                        }`}
                                    >
                                        <input
                                            type="radio"
                                            name="importType"
                                            value="purchase-receipts"
                                            checked={importType === "purchase-receipts"}
                                            onChange={() => setImportType("purchase-receipts")}
                                        />
                                        <span className="sync-import-type-body">
                                            <strong>Purchase Receipts</strong>
                                            <span>
                                                Receipt list export (Receipt Nbr., Status, Date,
                                                Vendor, Total Qty., Currency…).
                                            </span>
                                        </span>
                                    </label>
                                </div>

                                <div
                                    className={`sync-import-dropzone ${
                                        importDragOver ? "is-dragover" : ""
                                    } ${importFile ? "has-file" : ""}`}
                                    onDragEnter={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        dragDepthRef.current += 1;
                                        setImportDragOver(true);
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (dragDepthRef.current === 0) setImportDragOver(false);
                                    }}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        dragDepthRef.current = 0;
                                        setImportDragOver(false);
                                        const file = e.dataTransfer.files?.[0];
                                        pickImportFile(file);
                                    }}
                                >
                                    <input
                                        ref={fileInputRef}
                                        id="sync-import-file"
                                        className="sync-import-file-input"
                                        type="file"
                                        accept={IMPORT_ACCEPT}
                                        onChange={(e) =>
                                            pickImportFile(e.target.files?.[0] || null)
                                        }
                                    />
                                    <label
                                        htmlFor="sync-import-file"
                                        className="sync-import-dropzone-label"
                                    >
                                        <span className="sync-import-dropzone-icon" aria-hidden="true">
                                            <IconUpload />
                                        </span>
                                        {importFile ? (
                                            <>
                                                <strong className="sync-import-dropzone-title">
                                                    {importFile.name}
                                                </strong>
                                                <span className="sync-import-dropzone-hint">
                                                    {(importFile.size / 1024).toLocaleString(undefined, {
                                                        maximumFractionDigits: 1,
                                                    })}{" "}
                                                    KB — drop another file to replace, or click to browse
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <strong className="sync-import-dropzone-title">
                                                    Drag & drop your file here
                                                </strong>
                                                <span className="sync-import-dropzone-hint">
                                                    or click to browse · .xlsx, .xls, .csv
                                                </span>
                                            </>
                                        )}
                                    </label>
                                    {importFile ? (
                                        <button
                                            type="button"
                                            className="sync-import-clear"
                                            onClick={() => {
                                                setImportFile(null);
                                                setImportError(null);
                                                if (fileInputRef.current) fileInputRef.current.value = "";
                                            }}
                                        >
                                            Clear
                                        </button>
                                    ) : null}
                                </div>
                                {importError ? (
                                    <p className="sync-import-error" role="alert">
                                        {importError}
                                    </p>
                                ) : null}
                                <div className="sync-import-actions">
                                    <button
                                        type="button"
                                        className="sync-btn sync-btn-ghost"
                                        onClick={() => {
                                            setShowImport(false);
                                            setImportFile(null);
                                            setImportType("inventory");
                                            setImportDragOver(false);
                                            setImportError(null);
                                            dragDepthRef.current = 0;
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="sync-btn sync-btn-primary"
                                        disabled={!importFile || isSyncing}
                                        onClick={startImport}
                                    >
                                        {importFile
                                            ? `Import ${importFile.name}`
                                            : "Select a file first"}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </section>
                ) : (
                    <section
                        className={`sync-run ${error ? "is-error" : complete ? "is-done" : "is-active"}`}
                        aria-live="polite"
                    >
                        <div className={`sync-run-banner ${error ? "error" : complete ? "complete" : "syncing"}`}>
                            <span className="sync-run-dot" aria-hidden="true" />
                            <div className="sync-run-banner-text">
                                <strong>
                                    {complete
                                        ? "Synchronization complete"
                                        : error
                                        ? "Synchronization failed"
                                        : `Running ${
                                              syncMode === "full"
                                                  ? "Full"
                                                  : syncMode === "import"
                                                    ? "Import"
                                                    : "Quick"
                                          } Sync`}
                                </strong>
                                {!complete && !error ? (
                                    <span>Streaming progress from Acumatica…</span>
                                ) : error ? (
                                    <span>{error}</span>
                                ) : (
                                    <span>MySQL is up to date with the latest pull.</span>
                                )}
                            </div>
                            {complete ? <IconCheck /> : null}
                            {error ? <IconAlert /> : null}
                        </div>

                        <div className="sync-run-score">
                            <div
                                className="sync-run-pct"
                                style={{
                                    "--sync-pct": `${overallProgress}%`,
                                    color: error
                                        ? "var(--status-danger)"
                                        : complete
                                        ? "var(--status-success)"
                                        : "var(--accent-primary)",
                                }}
                            >
                                {overallProgress}
                                <span>%</span>
                            </div>
                            <p className="sync-run-pct-label">Overall progress</p>
                            <div className="sync-run-ring-track" aria-hidden="true">
                                <div
                                    className="sync-run-ring-fill"
                                    style={{
                                        width: `${overallProgress}%`,
                                        background: error
                                            ? "var(--status-danger)"
                                            : complete
                                            ? "var(--status-success)"
                                            : "var(--accent-primary)",
                                    }}
                                />
                            </div>
                        </div>

                        {sectionEntries.length > 0 ? (
                            <div className="sync-sections">
                                {sectionEntries.map(([name, data]) => (
                                    <div key={name} className="sync-section-row">
                                        <div className="sync-section-head">
                                            <div className="sync-section-title">
                                                <span>{name}</span>
                                                {data.count > 0 ? (
                                                    <span className="sync-section-count">
                                                        {data.count.toLocaleString()}{" "}
                                                        {name === "Inventory"
                                                            ? "items"
                                                            : name === "Purchase Receipts"
                                                              ? "receipts"
                                                              : "records"}
                                                    </span>
                                                ) : null}
                                            </div>
                                            <span
                                                className={`sync-section-pct ${
                                                    data.status === "done"
                                                        ? "is-done"
                                                        : data.status === "error"
                                                          ? "is-error"
                                                          : ""
                                                }`}
                                            >
                                                {data.progress}%
                                            </span>
                                        </div>
                                        <div className="sync-section-track">
                                            <div
                                                className={`sync-section-bar ${
                                                    data.status === "error"
                                                        ? "is-error"
                                                        : data.status === "done"
                                                        ? "is-done"
                                                        : ""
                                                }`}
                                                style={{ width: `${data.progress}%` }}
                                            />
                                        </div>
                                        {data.details ? (
                                            <p className="sync-section-detail">{data.details}</p>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        <div className="sync-log" role="log" aria-label="Sync log">
                            <div className="sync-log-head">Live log</div>
                            <div className="sync-log-body">
                                {logs.length === 0 ? (
                                    <div className="sync-log-line is-muted">Waiting for events…</div>
                                ) : (
                                    logs.map((log, i) => (
                                        <div key={i} className="sync-log-line">
                                            {log}
                                        </div>
                                    ))
                                )}
                                <div ref={logsEndRef} />
                            </div>
                        </div>

                        {(complete || error) && (
                            <div className="sync-run-actions">
                                <button type="button" className="sync-btn sync-btn-ghost" onClick={resetToChooser}>
                                    Sync again
                                </button>
                                <Link href="/dashboard" className="sync-btn sync-btn-primary">
                                    Back to dashboard
                                </Link>
                            </div>
                        )}
                    </section>
                )}

                {!isSyncing && (
                    <section className="sync-history" aria-labelledby="sync-history-title" data-tour="main-table">
                        <div className="sync-history-head">
                            <h2 id="sync-history-title">
                                <IconSync /> Recent sync history
                            </h2>
                        </div>

                        <div className="sync-history-panel">
                            <table className="sync-history-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Mode</th>
                                        <th>Section</th>
                                        <th>Status</th>
                                        <th className="is-num">Records</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {loadingHistory ? (
                                        <tr>
                                            <td colSpan={5} className="sync-history-empty">
                                                Loading history…
                                            </td>
                                        </tr>
                                    ) : history.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="sync-history-empty">
                                                No sync history yet. Run a Quick or Full Sync to get started.
                                            </td>
                                        </tr>
                                    ) : (
                                        history.map((h) => (
                                            <tr key={h.id}>
                                                <td>{new Date(h.timestamp).toLocaleString()}</td>
                                                <td>
                                                    <span className="sync-mode-tag">{formatMode(h.mode)}</span>
                                                </td>
                                                <td>{h.section}</td>
                                                <td>
                                                    <span className={`sync-status-tag ${statusClass(h.status)}`}>
                                                        {h.status}
                                                    </span>
                                                </td>
                                                <td className="is-num">
                                                    {h.records > 0 ? h.records.toLocaleString() : "—"}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}
            </main>
        </div>
    );
}
