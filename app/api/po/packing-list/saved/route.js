import { NextResponse } from "next/server";
import { branchAllowed, getRequestBranchAccess, hasNoBranchAccess } from "@/lib/branch-access";
import { describePackingListChange, normalizeSavedPackingList } from "@/lib/packing-list-saved";
import { recordPackingListActivity } from "@/lib/packing-list-activity";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Saved packing lists the user can see, optionally for one branch. */
export async function GET(request) {
    try {
        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) return NextResponse.json({ lists: [] }, NO_STORE);
        const branch = (new URL(request.url).searchParams.get("branch") || "").trim().toUpperCase();
        if (branch && !branchAllowed(access, branch)) return NextResponse.json({ lists: [] }, NO_STORE);
        const lists = await MySqlService.listPackingLists({
            branch,
            branches: access.allBranches ? null : access.branchIds.map((b) => String(b).toUpperCase()),
        });
        const snapshots = await MySqlService.latestPackingListSnapshots(lists.map((l) => l.id)).catch((err) => {
            console.error("[Saved packing lists] snapshots", err?.message || err);
            return {};
        });
        return NextResponse.json({ lists: lists.map((l) => ({ ...l, snapshot: snapshots[l.id] || null })) }, NO_STORE);
    } catch (err) {
        console.error("[Saved packing lists] list", err?.message || err);
        return NextResponse.json({ message: "Could not load saved packing lists. Please try again." }, { status: 500 });
    }
}

export async function POST(request) {
    try {
        const access = await getRequestBranchAccess(request);
        if (!access.user) return NextResponse.json({ message: "Sign in again to save packing lists." }, { status: 401 });
        const body = await request.json().catch(() => null);
        const { value, error } = normalizeSavedPackingList(body);
        if (error) return NextResponse.json({ message: error }, { status: 400 });
        if (!branchAllowed(access, value.branch)) {
            return NextResponse.json({ message: "You do not have access to this branch." }, { status: 403 });
        }
        const saved = await MySqlService.createPackingList(value, access.user.username);
        await recordPackingListActivity(saved, "created", describePackingListChange(null, value), value, access.user.username);
        return NextResponse.json({ list: { ...saved, snapshot: value.snapshot } }, { status: 201, ...NO_STORE });
    } catch (err) {
        console.error("[Saved packing lists] create", err?.message || err);
        return NextResponse.json({ message: "Could not save the packing list. Please try again." }, { status: 500 });
    }
}
