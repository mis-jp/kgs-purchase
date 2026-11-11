import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getSessionFromRequest } from "@/lib/session-store";
import { MySqlService } from "@/services/mysql";
import { mapHeaders, rowToDimensions } from "@/lib/item-dimensions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.map((line) => {
        const cells = [];
        let cur = "";
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQ = !inQ;
                continue;
            }
            if (ch === "," && !inQ) {
                cells.push(cur);
                cur = "";
                continue;
            }
            cur += ch;
        }
        cells.push(cur);
        return cells.map((c) => c.trim().replace(/^"|"$/g, ""));
    });
}

function sheetToRows(buffer, filename = "") {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const wb = XLSX.read(buffer, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === "data") || wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    }
    const text = buffer.toString("utf8");
    return parseCsv(text);
}

export async function POST(request) {
    const cookie = getSessionFromRequest(request);
    if (!cookie) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

    try {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") {
            return NextResponse.json({ message: "No file uploaded" }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const rows = sheetToRows(buffer, file.name || "");
        if (rows.length < 2) {
            return NextResponse.json({ message: "File has no data rows" }, { status: 400 });
        }

        const headerMap = mapHeaders(rows[0]);
        if (headerMap.inventory_id === undefined) {
            return NextResponse.json({ message: "Missing Inventory ID column" }, { status: 400 });
        }

        const parsed = [];
        for (let i = 1; i < rows.length; i++) {
            const dim = rowToDimensions(rows[i], headerMap);
            if (dim) parsed.push(dim);
        }

        const mode = form.get("mode") === "replace" ? "replace" : "fill";
        const result = await MySqlService.importItemDimensions(parsed, { mode });

        const parts = [`Updated ${result.imported} item(s).`];
        if (mode === "replace") parts.push(`${result.replacedItems} had saved values replaced.`);
        if (result.unchanged) {
            parts.push(mode === "replace"
                ? `${result.unchanged} already matched the file.`
                : `${result.unchanged} already had values and were kept.`);
        }
        if (result.skipped) parts.push(`Skipped ${result.skipped} unknown ID(s).`);

        return NextResponse.json({ message: parts.join(" "), ...result });
    } catch (err) {
        console.error("[Dimensions Import]", err);
        return NextResponse.json({ message: err.message }, { status: 500 });
    }
}
