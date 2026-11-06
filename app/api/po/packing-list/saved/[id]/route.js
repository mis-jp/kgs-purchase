import { NextResponse } from "next/server";
import { branchAllowed, getRequestBranchAccess } from "@/lib/branch-access";
import { canEditSavedPackingList, normalizeSavedPackingList } from "@/lib/packing-list-saved";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

async function loadForUser(request, params) {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id < 1) return { res: NextResponse.json({ message: "Invalid packing list." }, { status: 400 }) };
    const access = await getRequestBranchAccess(request);
    const record = await MySqlService.getPackingList(id);
    if (!record || !branchAllowed(access, record.branch)) {
        return { res: NextResponse.json({ message: "Packing list not found." }, { status: 404 }) };
    }
    return { id, access, record };
}

export async function GET(request, { params }) {
    try {
        const { res, record } = await loadForUser(request, params);
        if (res) return res;
        return NextResponse.json({ list: record }, NO_STORE);
    } catch (err) {
        console.error("[Saved packing lists] get", err?.message || err);
        return NextResponse.json({ message: "Could not open the packing list. Please try again." }, { status: 500 });
    }
}

export async function PUT(request, { params }) {
    try {
        const { res, id, access, record } = await loadForUser(request, params);
        if (res) return res;
        if (!canEditSavedPackingList(record, access.user)) {
            return NextResponse.json({ message: "Only the person who saved this list or an admin can change it. Use Save as new instead." }, { status: 403 });
        }
        const body = await request.json().catch(() => null);
        const { value, error } = normalizeSavedPackingList(body);
        if (error) return NextResponse.json({ message: error }, { status: 400 });
        if (!branchAllowed(access, value.branch)) {
            return NextResponse.json({ message: "You do not have access to this branch." }, { status: 403 });
        }
        const saved = await MySqlService.updatePackingList(id, value, access.user.username);
        return NextResponse.json({ list: saved }, NO_STORE);
    } catch (err) {
        console.error("[Saved packing lists] update", err?.message || err);
        return NextResponse.json({ message: "Could not update the packing list. Please try again." }, { status: 500 });
    }
}

export async function DELETE(request, { params }) {
    try {
        const { res, id, access, record } = await loadForUser(request, params);
        if (res) return res;
        if (!canEditSavedPackingList(record, access.user)) {
            return NextResponse.json({ message: "Only the person who saved this list or an admin can delete it." }, { status: 403 });
        }
        await MySqlService.deletePackingList(id);
        return NextResponse.json({ ok: true }, NO_STORE);
    } catch (err) {
        console.error("[Saved packing lists] delete", err?.message || err);
        return NextResponse.json({ message: "Could not delete the packing list. Please try again." }, { status: 500 });
    }
}
