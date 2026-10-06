import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";
import {
    requireAdmin,
    sanitizeUserWithBranches,
    hashPassword,
    validateUsername,
    validatePassword,
} from "@/lib/app-users";
import { normalizeBranchIds } from "@/lib/branch-access";
import { normalizeModuleAccessInput, serializeAllowedModules } from "@/lib/module-access";
import { setLocalUserSession, getSessionIdFromRequest } from "@/lib/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request, { params }) {
    try {
        const admin = await requireAdmin(request);
        const id = Number((await params).id);
        if (!Number.isFinite(id) || id < 1) {
            return NextResponse.json({ message: "Invalid user id" }, { status: 400 });
        }

        const existing = await MySqlService.getAppUserById(id);
        if (!existing) {
            return NextResponse.json({ message: "User not found" }, { status: 404 });
        }

        const body = await request.json();
        const fields = {};

        if (body.username !== undefined) {
            const username = String(body.username || "").trim();
            const userErr = validateUsername(username);
            if (userErr) return NextResponse.json({ message: userErr }, { status: 400 });
            const clash = await MySqlService.getAppUserByUsername(username);
            if (clash && Number(clash.id) !== id) {
                return NextResponse.json({ message: "Username already exists." }, { status: 409 });
            }
            fields.username = username;
        }

        if (body.password !== undefined && body.password !== "") {
            const passErr = validatePassword(body.password);
            if (passErr) return NextResponse.json({ message: passErr }, { status: 400 });
            fields.passwordHash = hashPassword(body.password);
        }

        if (body.fullName !== undefined) fields.fullName = body.fullName;
        if (body.email !== undefined) fields.email = body.email;

        if (body.role !== undefined) {
            const nextRole = body.role === "admin" ? "admin" : "user";
            // Prevent removing the last active admin
            if (existing.role === "admin" && nextRole !== "admin") {
                const adminCount = await MySqlService.countAppAdmins();
                if (adminCount <= 1) {
                    return NextResponse.json(
                        { message: "Cannot demote the last active admin." },
                        { status: 400 }
                    );
                }
            }
            fields.role = nextRole;
        }

        if (body.active !== undefined) {
            const nextActive = !!body.active;
            if (existing.role === "admin" && existing.active && !nextActive) {
                const adminCount = await MySqlService.countAppAdmins();
                if (adminCount <= 1) {
                    return NextResponse.json(
                        { message: "Cannot deactivate the last active admin." },
                        { status: 400 }
                    );
                }
            }
            fields.active = nextActive;
        }

        const nextRole = fields.role || (existing.role === "admin" ? "admin" : "user");
        if (nextRole === "admin") {
            fields.allowedModules = null;
        } else if (body.moduleAccess !== undefined || body.allowedModules !== undefined) {
            fields.allowedModules = serializeAllowedModules(
                normalizeModuleAccessInput(body.moduleAccess || body.allowedModules)
            );
        }
        const grantAll = nextRole === "admin" || body.allBranches === true;
        const branchIds = body.branchIds !== undefined ? normalizeBranchIds(body.branchIds) : null;
        if (nextRole === "user" && !grantAll && branchIds && !branchIds.length) {
            return NextResponse.json(
                { message: "Select at least one branch, or choose All branches." },
                { status: 400 }
            );
        }
        if (body.allBranches !== undefined || fields.role !== undefined) {
            fields.allBranches = grantAll;
        }

        await MySqlService.updateAppUser(id, fields);
        if (grantAll || branchIds || fields.role !== undefined) {
            await MySqlService.setAppUserBranches(
                id,
                grantAll ? [] : (branchIds || await MySqlService.getAppUserBranchIds(id))
            );
        }
        const updated = await sanitizeUserWithBranches(await MySqlService.getAppUserById(id));

        // Keep current session profile in sync if editing self
        if (Number(admin.id) === id) {
            const sessionId = getSessionIdFromRequest(request);
            if (sessionId) setLocalUserSession(sessionId, updated);
        }

        return NextResponse.json({ user: updated });
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to update user" }, { status });
    }
}

export async function DELETE(request, { params }) {
    try {
        const admin = await requireAdmin(request);
        const id = Number((await params).id);
        if (!Number.isFinite(id) || id < 1) {
            return NextResponse.json({ message: "Invalid user id" }, { status: 400 });
        }

        const existing = await MySqlService.getAppUserById(id);
        if (!existing) {
            return NextResponse.json({ message: "User not found" }, { status: 404 });
        }

        if (Number(admin.id) === id) {
            return NextResponse.json({ message: "You cannot delete your own account." }, { status: 400 });
        }

        if (existing.role === "admin") {
            const adminCount = await MySqlService.countAppAdmins();
            if (adminCount <= 1) {
                return NextResponse.json(
                    { message: "Cannot delete the last active admin." },
                    { status: 400 }
                );
            }
        }

        await MySqlService.deleteAppUser(id);
        return NextResponse.json({ success: true });
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to delete user" }, { status });
    }
}
