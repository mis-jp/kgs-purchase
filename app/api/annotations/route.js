import { MySqlService } from "@/services/mysql";
import { NextResponse } from "next/server";
import { logUserActivity, summarizeActivityDetail } from "@/lib/activity-log";
import { filterAnnotationsForOrder } from "@/lib/po-metrics";

/**
 * Handle persistent user annotations (ETAs, Statuses, Lead Times)
 */
export async function GET(req) {
    try {
        const { searchParams } = new URL(req.url);
        const moduleName = searchParams.get("module");

        if (!moduleName) {
            return NextResponse.json({ message: "Module name is required" }, { status: 400 });
        }

        // Optional: scope to one PO (detail page) so other orders' entries are not read or sent.
        const orderNbr = (searchParams.get("orderNbr") || "").trim();
        if (orderNbr) {
            const scoped = await MySqlService.getAnnotationsForOrder(moduleName, orderNbr);
            return NextResponse.json(filterAnnotationsForOrder(scoped, orderNbr));
        }
        const annotations = await MySqlService.getAnnotations(moduleName);
        return NextResponse.json(annotations);
    } catch (err) {
        console.error("[Annotations API GET Error]", err);
        return NextResponse.json({ message: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req) {
    try {
        const body = await req.json();
        const { module: moduleName, refId, fieldKey, fieldValue } = body;

        if (!moduleName || !refId || !fieldKey) {
            return NextResponse.json({ message: "Missing required fields" }, { status: 400 });
        }

        const success = await MySqlService.upsertAnnotation(moduleName, refId, fieldKey, fieldValue);

        if (success) {
            await logUserActivity(req, {
                action: "annotation_save",
                moduleName,
                refId,
                fieldKey,
                detail: summarizeActivityDetail(fieldValue),
            });
            return NextResponse.json({ message: "Annotation saved" });
        }
        return NextResponse.json({ message: "Failed to save annotation" }, { status: 500 });
    } catch (err) {
        console.error("[Annotations API POST Error]", err);
        return NextResponse.json({ message: "Internal server error" }, { status: 500 });
    }
}
