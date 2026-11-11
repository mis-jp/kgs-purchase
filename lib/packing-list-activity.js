import { MySqlService } from "@/services/mysql";

/** Writes a history row; never fails the save itself if the history table is unavailable. */
export async function recordPackingListActivity(list, action, summary, value, username) {
    try {
        await MySqlService.addPackingListActivity({
            packingListId: list.id,
            listName: list.name,
            action,
            summary,
            orderCount: value?.orderNbrs ? value.orderNbrs.length : null,
            snapshot: value?.snapshot || null,
            username,
        });
    } catch (err) {
        console.error("[Saved packing lists] activity", err?.message || err);
    }
}
