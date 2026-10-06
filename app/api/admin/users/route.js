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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
    try {
        await requireAdmin(request);
        await MySqlService.ensureAppUsersTable();
        const rows = await MySqlService.listAppUsers();
        const users = await Promise.all(rows.map((row) => sanitizeUserWithBranches(row)));
        return NextResponse.json({ users });
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to list users" }, { status });
    }
}

export async function POST(request) {
    try {
        await requireAdmin(request);
        await MySqlService.ensureAppUsersTable();
        const body = await request.json();
        const username = String(body.username || "").trim();
        const password = body.password;
        const fullName = String(body.fullName || "").trim();
        const email = String(body.email || "").trim();
        const role = body.role === "admin" ? "admin" : "user";
        const active = body.active !== false;

        const userErr = validateUsername(username);
        if (userErr) return NextResponse.json({ message: userErr }, { status: 400 });
        const passErr = validatePassword(password);
        if (passErr) return NextResponse.json({ message: passErr }, { status: 400 });

        const existing = await MySqlService.getAppUserByUsername(username);
        if (existing) {
            return NextResponse.json({ message: "Username already exists." }, { status: 409 });
        }

        const grantAll = role === "admin" || body.allBranches === true;
        const branchIds = normalizeBranchIds(body.branchIds);
        if (role === "user" && !grantAll && !branchIds.length) {
            return NextResponse.json(
                { message: "Select at least one branch, or choose All branches." },
                { status: 400 }
            );
        }

        const allowedModules = role === "admin"
            ? null
            : serializeAllowedModules(normalizeModuleAccessInput(body.moduleAccess || body.allowedModules));

        const id = await MySqlService.createAppUser({
            username,
            passwordHash: hashPassword(password),
            fullName,
            email,
            role,
            active,
            allowedModules,
            allBranches: grantAll,
        });
        await MySqlService.setAppUserBranches(id, grantAll ? [] : branchIds);
        const created = await MySqlService.getAppUserById(id);
        return NextResponse.json({ user: await sanitizeUserWithBranches(created) }, { status: 201 });
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to create user" }, { status });
    }
}
