# KGS Purchase — Inventory API for the Flutter App

The Flutter app talks only to the KGS Purchase server. It never connects to MySQL or Acumatica directly — the server reads MySQL (and Acumatica where noted) with credentials that stay on the server.

**Base URL:** `http://190.92.233.232/kgs-purchase`

Health check: `GET http://190.92.233.232/kgs-purchase/api/health` returns `{"ok":true,"app":true,"database":true,"purchase":true,"inventory":true}`.

---

## 1. Flutter packages

```yaml
dependencies:
  http: ^1.2.0
  flutter_secure_storage: ^9.0.0
```

- `http` — API calls
- `flutter_secure_storage` — keeps the session ID safely on the device

---

## 2. Allow plain http (the server is not on https yet)

**Android** — `android/app/src/main/AndroidManifest.xml`:

```xml
<application
    android:usesCleartextTraffic="true"
    ...>
```

**iOS** — `ios/Runner/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>190.92.233.232</key>
    <dict>
      <key>NSExceptionAllowsInsecureHTTPLoads</key>
      <true/>
    </dict>
  </dict>
</dict>
```

---

## 3. Login flow

1. Login screen uses the same username and password as the web app.
2. `POST /api/auth/login` with body:

   ```json
   { "username": "...", "password": "..." }
   ```

   Response:

   ```json
   { "success": true, "sessionId": "....", "authType": "local", "user": { ... } }
   ```

3. Save `sessionId` in secure storage.
4. Send this header on every request:

   ```
   Authorization: Bearer <sessionId>
   ```

5. On app start, call `GET /api/auth/session`:
   - `200` → go to the home screen
   - `401` → go to login
6. Logout: `GET /api/auth/logout`, then delete the saved session ID.

No cookie handling is needed; the Bearer header replaces it.

---

## 4. Screens and endpoints

| Screen | Endpoint | Data source |
|---|---|---|
| Dashboard totals | `GET /api/inventory?statsOnly=true&branch=` | MySQL |
| Inventory list | `GET /api/inventory?page=1&pageSize=50&search=&branch=&filter=` | MySQL |
| Branch picker | `GET /api/branches` | MySQL |
| Stock items catalog | `GET /api/stock-items?page=1&pageSize=50&search=&itemClass=` | MySQL |
| Item detail | `GET /api/stock-items/{inventoryId}` | MySQL (falls back to Acumatica) |
| Weight / box size / CBM | `GET /api/stock-items/dimensions?ids=A,B,C` | MySQL |
| Warehouse locations | `GET /api/inventory/locations?inventoryId=X&branch=MAIN` | Acumatica live |
| Company list / switch | `GET /api/company`, `POST /api/company` | Session |

### `/api/inventory` parameters

| Parameter | Meaning |
|---|---|
| `page`, `pageSize` | Paging |
| `search` | Item ID or description |
| `branch` | e.g. `MAIN` (only branches the user is allowed to see) |
| `filter` | `low_stock`, `out_of_stock`, `dead_stock`, `overstock`, `damage` |
| `stats=true` | Include totals with the list |
| `statsOnly=true` | Totals only, no rows |
| `enrich=true` | Adds qty sold, total sales, supplier and lead time |

### `/api/stock-items` parameters

| Parameter | Meaning |
|---|---|
| `page`, `pageSize` | Paging (max 100 per page) |
| `search` | Item ID or description |
| `itemClass` | Item class filter |
| `dimsStatus` | `set` or `unset` (items with / without dimensions) |
| `cursor` | Faster scrolling: pass the previous page's `nextCursor` |

### `/api/stock-items/dimensions`

- `ids` — comma-separated inventory IDs, up to 200 at once.

### `/api/inventory/locations`

- Live from Acumatica, slower and rate-limited. Only call it when the user opens an item's locations view.

### `/api/company`

- `GET` lists the companies.
- `POST` with `{"companyId": "main"}` or `{"companyId": "ecommerce"}` switches the active company.

---

## 5. Response shapes (data models)

### Inventory list — `/api/inventory`

```json
{
  "data": [
    {
      "InventoryID":  { "value": "120108011000600" },
      "Description":  { "value": "..." },
      "Branch":       { "value": "MAIN" },
      "SiteID":       { "value": "..." },
      "OnHand":       { "value": 12 },
      "Available":    { "value": 10 },
      "DefaultPrice": { "value": 0 },
      "ItemClass":    { "value": "..." },
      "VendorID":     { "value": "..." },
      "LeadTimeDays": { "value": 30 },
      "SafetyStock":  { "value": null },
      "MOQ":          { "value": null },
      "QtySold":      { "value": 0 }
    }
  ],
  "totalCount": 1234,
  "hasMore": true,
  "page": 1,
  "pageSize": 50,
  "globalStats": {
    "totalStock": 0, "totalValue": 0, "lowStock": 0, "outOfStock": 0,
    "deadStock": 0, "overstock": 0, "damageStock": 0, "count": 0, "lastSync": "..."
  }
}
```

Fields are wrapped in `{ "value": ... }` — read them like `json['OnHand']['value']`. `globalStats` is only present with `stats=true` or `statsOnly=true`.

### Stock items — `/api/stock-items`

```json
{
  "items": [
    {
      "inventoryId": "...",
      "description": "...",
      "itemClass": "...",
      "itemStatus": "Active",
      "price": 0,
      "totalOnHand": 0,
      "hasDimensions": true,
      "weightKg": 1.5,
      "pcsPerBox": 10
    }
  ],
  "totalCount": 1234,
  "totalStock": 0,
  "nextCursor": "..."
}
```

### Item detail — `/api/stock-items/{inventoryId}`

```json
{
  "inventoryId": "...",
  "description": "...",
  "itemClass": "...",
  "unitPrice": 0,
  "itemStatus": "Active",
  "baseUnit": "PCS",
  "totalOnHand": 0,
  "totalAvailable": 0,
  "lastSync": "...",
  "branches": [
    { "branchId": "MAIN", "siteId": "...", "onHand": 0, "available": 0, "updatedAt": "..." }
  ],
  "dimensions": {
    "pcs_per_box": 10, "length_m": 0.5, "height_m": 0.3, "width_m": 0.4,
    "weight_kg": 1.5, "cbm": 0.06
  },
  "source": "mysql"
}
```

### Dimensions batch — `/api/stock-items/dimensions?ids=A,B`

```json
{
  "dimensions": {
    "A": { "inventoryId": "A", "pcs_per_box": 10, "length_m": 0.5, "height_m": 0.3,
           "width_m": 0.4, "weight_kg": 1.5, "cbm": 0.06 }
  }
}
```

---

## 6. Error handling

| Status | Meaning | What the app should do |
|---|---|---|
| `401` | Session expired / not signed in | Go to login |
| `429` | Acumatica busy (locations endpoint) | Show "try again shortly" |
| `503` | Database or Acumatica not answering | Show a retry button |
| `500` | Server error | Show the `message` from the response |

Paging: keep loading while `hasMore` is `true` (inventory) or `nextCursor` is not `null` (stock items).

---

## 7. Example Dart code

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const base = 'http://190.92.233.232/kgs-purchase';
const storage = FlutterSecureStorage();

Future<void> login(String username, String password) async {
  final r = await http.post(
    Uri.parse('$base/api/auth/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'username': username, 'password': password}),
  );
  final body = jsonDecode(r.body);
  if (r.statusCode != 200) throw Exception(body['message'] ?? 'Login failed');
  await storage.write(key: 'sessionId', value: body['sessionId']);
}

Future<Map<String, String>> _headers() async {
  final id = await storage.read(key: 'sessionId');
  return {'Authorization': 'Bearer $id'};
}

Future<Map<String, dynamic>> getInventory({
  int page = 1,
  String search = '',
  String branch = '',
  String filter = '',
}) async {
  final uri = Uri.parse('$base/api/inventory').replace(queryParameters: {
    'page': '$page',
    'pageSize': '50',
    'search': search,
    'branch': branch,
    'filter': filter,
    'stats': 'true',
  });
  final r = await http.get(uri, headers: await _headers());
  if (r.statusCode == 401) throw Exception('Session expired');
  return jsonDecode(r.body);
}

Future<Map<String, dynamic>> getItemDetail(String inventoryId) async {
  final r = await http.get(
    Uri.parse('$base/api/stock-items/${Uri.encodeComponent(inventoryId)}'),
    headers: await _headers(),
  );
  if (r.statusCode == 401) throw Exception('Session expired');
  return jsonDecode(r.body);
}

Future<void> logout() async {
  await http.get(Uri.parse('$base/api/auth/logout'), headers: await _headers());
  await storage.delete(key: 'sessionId');
}
```

---

## 8. What you do NOT need in the app

- MySQL host, user or password
- Acumatica credentials
- Cookie handling

---

## 9. Notes

- **Accounts:** create the mobile users in the web app's Admin page and give them only the branches and modules they need. The API enforces the same branch limits as the web app.
- **Write access:** the same session can call save endpoints (e.g. `PUT /api/stock-items/{inventoryId}/dimensions`), so use accounts with only the access the app needs.
- **Flutter Web:** Android/iOS/desktop work as-is. A Flutter Web build would need the server to send CORS headers, which it does not do yet.
- **Security:** the server is plain `http`, so passwords and session IDs travel unencrypted. Put it behind a domain with an https certificate when possible, then remove the cleartext settings from section 2.
