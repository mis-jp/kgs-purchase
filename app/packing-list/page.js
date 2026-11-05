"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { loadAllBranchesAccess } from "@/lib/user-access-client";
import PackingListGenerator from "@/components/packing-list/PackingListGenerator";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";
import "@/styles/packing-list.css";

function branchOption(b) {
    const rawName = b.Description?.value || b.Description || b.BranchName?.value || b.branch_name || "";
    const name = rawName && !String(rawName).startsWith("[object")
        ? String(rawName)
        : (b.SiteID || b.branch_id || "");
    return { id: b.SiteID || b.branch_id || "", name };
}

export default function PackingListPage() {
    const [branches, setBranches] = useState({ loaded: false, options: [], allowAll: false, defaultBranch: "" });

    useEffect(() => {
        let active = true;
        (async () => {
            const savedBranch = localStorage.getItem("po_filter_branch") || "";
            try {
                const res = await fetchWithAuth("/api/branches");
                const list = res.ok ? await res.json() : [];
                const options = (Array.isArray(list) ? list : []).map(branchOption).filter((b) => b.id);
                const allowAll = await loadAllBranchesAccess(fetchWithAuth);
                const defaultBranch = options.some((b) => b.id === savedBranch)
                    ? savedBranch
                    : (allowAll ? "" : options[0]?.id || "");
                if (active) setBranches({ loaded: true, options, allowAll, defaultBranch });
            } catch (err) {
                console.error("Failed to load branches", err);
                if (active) setBranches((prev) => ({ ...prev, loaded: true }));
            }
        })();
        return () => { active = false; };
    }, []);

    return (
        <div className="po-root">
            <main className="po-main">
                <div className="db-page-title" data-tour="page-title">
                    <h1>Packing List Generator</h1>
                    <p>Pick purchase orders by branch to build a packing list with total CBM, weight and containers.</p>
                </div>

                {branches.loaded ? (
                    <PackingListGenerator
                        key={branches.defaultBranch}
                        branchOptions={branches.options}
                        allowAllBranches={branches.allowAll}
                        defaultBranch={branches.defaultBranch}
                    />
                ) : (
                    <div className="pl-empty pl-empty-wide">Loading branches…</div>
                )}
            </main>
        </div>
    );
}
