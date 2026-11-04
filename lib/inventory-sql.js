/** Count unique inventory IDs; warehouse rows repeat the same item per site. */
export function inventoryDistinctCountSql(alias = "i", outputAlias = "total") {
    return `COUNT(DISTINCT TRIM(${alias}.inventory_id)) as ${outputAlias}`;
}
