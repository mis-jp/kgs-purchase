Multi-Branch Product Inventory System
Flutter Android Application — Project Requirements and Development Guide

Project Type: Inventory Management System
Platform: Android
Frontend: Flutter (Dart)
Backend: Firebase or REST API with a centralized database
Primary Goal: Monitor products across all company branches and maintain an accurate, traceable record of inventory movements and stock discrepancies.

1. Project Overview

The Multi-Branch Product Inventory System is an Android application designed to help the company manage products, stock quantities, and inventory movements across multiple branches in one centralized system.

The system will allow authorized staff to view inventory, while administrators and managers can monitor stock levels, review product movements, and investigate unexplained shortages.

A key feature is the All Branches inventory view, with a dropdown filter that lets users select a specific branch.

For example:

All Branches
Manila Branch
Quezon City Branch
Cebu Branch
Davao Branch

When a branch is selected, the system will display only the products and stock quantities associated with that branch.

Every important inventory action should be recorded with the user's account, timestamp, branch, product, quantity, and reason. These records will help management investigate missing stock and unauthorized transactions.

2. Project Objectives
Centralize product inventory for all company branches.
Provide a dropdown to filter inventory by branch.
Track incoming and outgoing products.
Record which authorized user performed each inventory transaction.
Maintain a history of stock adjustments, transfers, and corrections.
Detect unexpected stock shortages and inventory discrepancies.
Restrict sensitive operations based on user roles.
Generate inventory reports for management.
Reduce unauthorized stock changes and improve accountability.
Provide a system that can support additional branches in the future.
3. User Roles and Permissions

The system should use role-based access control.

Feature	Admin	Manager	Staff
View all branches	Yes	Yes	No, unless authorized
View assigned branch	Yes	Yes	Yes
Filter by branch	Yes	Yes	Assigned branches only
Add products	Yes	Optional	No
Receive stock	Yes	Yes	If authorized
Release stock	Yes	Yes	If authorized
Transfer stock	Yes	Yes	If authorized
Adjust inventory	Yes	With approval	No
View audit logs	Yes	Authorized scope	Own transactions, if permitted
Manage users	Yes	No	No
Export reports	Yes	Yes	Optional

Important: Permissions must be enforced by the backend, not just by hiding buttons in the Flutter interface.

A staff member should not be able to gain administrator access by modifying the app or sending requests directly to the backend.

4. Main Application Features
4.1 Login and Authentication

Users must sign in before accessing the inventory system.

Required fields:

Email or username
Password

Requirements:

Secure authentication.
Role-based access.
Branch assignments for each user.
Account activation and deactivation.
Password reset functionality.
Automatic session expiration where appropriate.
Recording of login activity and failed login attempts.

Each user should have a unique account. Shared accounts should not be used because they make inventory actions difficult to attribute to a specific person.

4.2 Dashboard

The dashboard should summarize inventory activity.

Suggested dashboard cards:

Total Products
Total Branches
Total Stock Units
Low Stock Products
Pending Stock Transfers
Inventory Discrepancies
Recent Inventory Transactions

Example layout:

+--------------------------------------+
|        PRODUCT INVENTORY             |
+--------------------------------------+
| Branch: [ All Branches           v ] |
+--------------------------------------+
| Total Products      | Total Stock    |
|       250           |    12,450      |
+--------------------------------------+
| Low Stock           | Discrepancies  |
|        12           |        4       |
+--------------------------------------+
| Recent Inventory Activity            |
|--------------------------------------|
| Product A  | Received   | +20        |
| Product B  | Released   | -5         |
| Product C  | Adjusted   | -2         |
+--------------------------------------+


The values above are examples only.

When the user changes the branch filter, dashboard totals should update to reflect the selected branch.

4.3 Inventory List With Branch Dropdown

This is the most important feature of the application.

The inventory page should display all products and their stock quantities for the selected branch.

Required filters:

Branch
Product name
SKU or barcode
Product category
Stock status

Example:

Product Inventory

Branch:
[ All Branches                 v ]

Search:
[ Search product or SKU          ]

Category:
[ All Categories               v ]

Stock Status:
[ All Stock Statuses           v ]

------------------------------------------------
Product       SKU        Branch        Quantity
------------------------------------------------
Rice 25 kg    RICE-001   Manila            120
Rice 25 kg    RICE-001   Cebu               85
Cooking Oil   OIL-001    Manila             40
Cooking Oil   OIL-001    Cebu               15
------------------------------------------------

Branch dropdown behavior

When "All Branches" is selected:

Show inventory across every branch the user is permitted to access.
Group or summarize quantities by product.
Show total stock across branches.
Allow authorized users to inspect each branch's individual quantity.

When a specific branch is selected:

Show only that branch's inventory.
Display that branch's available stock, reserved stock if applicable, and stock status.
Update dashboard totals and inventory reports.
Use the selected branch as the default branch when opening relevant inventory operations, subject to permissions.

Important: The total stock for all branches should not hide individual branch quantities. A product with 100 units in total might have 95 units in one branch and only 5 in another.

4.4 Product Management

Administrators should be able to create, edit, and deactivate products.

Suggested product fields:

Field	Description
Product ID	Unique internal identifier
SKU	Unique stock keeping unit
Barcode	Optional barcode value
Product Name	Product's display name
Category	Product category
Description	Optional product details
Unit of Measure	Piece, box, kilogram, liter, etc.
Minimum Stock	Low-stock alert threshold
Cost Price	Restricted financial information
Selling Price	Optional
Status	Active or inactive
Created At	Record creation timestamp
Created By	User who created the product

Use a permanent product ID even if the SKU or product name changes.

4.5 Branch Management

Administrators should be able to add and manage company branches.

Suggested fields:

Branch ID
Branch Code
Branch Name
Address
Contact Information
Branch Manager
Status
Created At

Each inventory record and transaction must reference a branch ID.

Do not identify branches only by their names because names can change or be duplicated.

4.6 Stock Receiving

This feature records products entering a branch.

Example:

Receive Stock

Branch:       Manila Branch
Product:      Rice 25 kg
Quantity:     50
Reference:    PO-2026-001
Reason:       Supplier delivery

[ Submit Receiving ]


When a receiving transaction is completed, the system should:

Validate the user's permission.
Validate the product, branch, and quantity.
Record the receiving transaction.
Increase the branch's stock.
Save the user's identity and timestamp.
Record the reference document, if applicable.
Display a transaction reference number.
4.7 Stock Release or Outgoing Stock

This feature records products leaving a branch.

Possible reasons:

Customer sale
Internal use
Damaged products
Supplier return
Approved disposal
Other authorized reasons

Required fields:

Branch
Product
Quantity
Transaction reason
Reference number, if applicable
Notes, if necessary

Before processing the transaction, the system must check that sufficient stock is available.

The backend should reject invalid quantities and prevent concurrent transactions from reducing stock below the permitted limit.

4.8 Branch-to-Branch Transfers

The application should support transfers between branches.

Example:

Stock Transfer

From Branch: Manila Branch
To Branch:   Cebu Branch
Product:     Rice 25 kg
Quantity:    20
Reason:      Replenishment

[ Submit Transfer ]


Recommended transfer statuses:

Draft
Pending Approval
Approved
In Transit
Received
Rejected
Cancelled

The system should record both the sending and receiving branches.

A transfer should not be treated as a completed receipt at the destination until the receiving process has been confirmed.

The stock deduction, transfer record, and related inventory entries must be processed safely so that a failed operation does not create or destroy stock.

4.9 Inventory Adjustment

An inventory adjustment records a correction when the recorded quantity differs from the actual physical count.

Examples:

Physical count shows fewer units than the system.
Damaged stock was discovered.
A previous transaction was entered incorrectly.
An approved correction is required.

Required fields:

Branch
Product
System quantity
Actual counted quantity
Difference
Adjustment reason
Supporting notes or attachment, if needed
Requested by
Approved by, where approval is required

For example:

Product: Rice 25 kg
Branch: Manila Branch

System Quantity:  120
Actual Quantity:  115
Difference:        -5

Reason:
[ Physical inventory count ]

Requested By: Staff Account
Approved By:  Manager Account

Status: Pending Approval


For significant discrepancies, require approval from a manager or administrator.

Do not allow users to silently overwrite stock quantities. Every correction must create a permanent transaction record.

5. Inventory Audit Trail

This is one of the most important components for investigating missing inventory.

Every stock movement and sensitive action should produce an audit record.

5.1 Information to Record
Field	Purpose
Audit ID	Unique audit record
Transaction ID	Related stock transaction
User ID	Account that performed the action
User Role	Role at the time of the action
Branch ID	Branch affected
Product ID	Product affected
Action Type	Receive, release, transfer, adjustment, etc.
Previous Quantity	Quantity before the transaction
Quantity Change	Increase or decrease
New Quantity	Quantity after the transaction
Reason	Explanation for the transaction
Reference Number	Supporting business document
Timestamp	Server-recorded date and time
Approval Status	Pending, approved, rejected, etc.
Approved By	Approver, if applicable
Notes	Additional context

For sensitive operations, also consider recording:

Failed transaction attempts.
Permission-denied events.
Product and branch master-data changes.
Account creation and deactivation.
Report exports.
Changes to user roles or branch access.
Relevant device or session identifiers.

Avoid storing passwords, authentication tokens, or unnecessary personal information in audit logs.

5.2 Audit Log Example
Inventory Audit Log

Date:       2026-10-20 10:15
User:       staff_023
Branch:     Manila Branch
Product:    Rice 25 kg
Action:     Stock Release
Previous:   120
Change:     -5
New Stock:  115
Reason:     Internal Use
Reference:  TXN-20261020-001
Status:     Completed


This example illustrates the format, not an actual transaction.

5.3 Audit Log Security

The audit trail should be designed so ordinary users cannot edit or delete historical records.

Recommended controls:

Restrict audit-log access by role.
Write logs on the backend.
Use append-only records wherever possible.
Separate audit-log permissions from inventory-edit permissions.
Monitor unusual changes and repeated failed attempts.
Back up the database and audit logs.
Consider tamper-evident logging for higher-risk operations.

An audit record identifies the account used for an action. It does not, by itself, prove who physically performed the action. For sensitive transactions, consider approval workflows, individual authentication, and additional verification.

6. Inventory Discrepancy Detection

The application should help management identify stock differences without automatically assuming that every shortage is theft.

6.1 Discrepancy Report

A report should include:

Product name and SKU
Branch
Expected stock
Physical count
Difference
Last stock movement
Relevant transaction history
Users associated with the transactions
Supporting notes or evidence
Investigation status

Example:

Inventory Discrepancy Report

Product:       Cooking Oil
Branch:        Cebu Branch
Expected:      50
Physical:      42
Difference:    -8

Investigation Status: Open

Related Activity:
- Stock received: +20
- Stock released: -10
- Stock released: -8
- Physical count recorded: 42


These example transactions are illustrative. A real investigation must use the actual system records and physical inventory count.

6.2 Suggested Alert Rules

Generate an alert when:

Physical stock differs from recorded stock.
A stock adjustment exceeds a configurable threshold.
An unusually large quantity is released.
Multiple adjustments occur within a short period.
A transaction is attempted without permission.
A transfer remains unconfirmed beyond the expected time.
A product repeatedly falls below its minimum stock level.

Alerts should trigger a review, not an automatic accusation against a staff member.

6.3 Investigation Workflow
Record the physical stock count.
Compare it with the system's recorded quantity.
Review the product's transaction history.
Check receiving documents, release records, and transfer confirmations.
Review related audit logs and approvals.
Record findings and supporting evidence.
Have an authorized manager close the investigation.

Preserve relevant records and limit access to investigation details to authorized personnel.

7. Recommended Technology Stack
Option A: Flutter + Firebase

Suitable for an initial version when the company wants a relatively fast development process.

Component	Technology
Android application	Flutter
Programming language	Dart
Authentication	Firebase Authentication
Database	Cloud Firestore
Server-side logic	Cloud Functions
File attachments	Cloud Storage
Notifications	Firebase Cloud Messaging
Reporting	Backend-generated CSV or PDF

Advantages:

Convenient authentication integration.
Supports real-time data updates.
Provides managed infrastructure.
Can be practical for a small or medium-sized deployment.

Important considerations:

Configure security rules carefully.
Do not allow clients to modify stock quantities without validation.
Use trusted server-side logic for stock movements and approvals.
Design transactions carefully to prevent duplicate or inconsistent stock changes.
Account for offline operations and synchronization conflicts.
Option B: Flutter + REST API + PostgreSQL

Suitable when the company needs more complex reporting, transaction management, and centralized business rules.

Component	Technology
Android application	Flutter
Programming language	Dart
Backend API	Node.js, NestJS, Laravel, or Django
Database	PostgreSQL
Authentication	Secure token-based authentication
File storage	Private object storage
Notifications	Firebase Cloud Messaging
Reports	Backend-generated CSV or PDF

Advantages:

Strong relational data modeling.
Database transactions for inventory movements.
Flexible reporting across branches.
Centralized permissions and validation.
Easier integration with other company systems.

Recommendation: For an inventory system intended to support investigations into missing stock, Flutter with a REST API and PostgreSQL is a strong long-term option. Firebase is also viable when implemented with strict server-side validation and security rules.

8. Suggested Database Structure

The following structure is a starting point for a relational database.

8.1 users

Stores application accounts.

users
-----
id
full_name
email
password_hash_or_identity_provider_id
role
status
created_at
updated_at


Store password hashes only when using an authentication system that manages passwords directly. When using an identity provider, store the provider's user identifier instead.

8.2 branches

Stores company branches.

branches
--------
id
branch_code
branch_name
address
status
created_at
updated_at

8.3 user_branches

Maps users to the branches they may access.

user_branches
-------------
id
user_id
branch_id
created_at


This table supports managers who oversee multiple branches and staff who are limited to specific locations.

8.4 products

Stores product information.

products
--------
id
sku
barcode
product_name
category_id
unit_of_measure
minimum_stock
status
created_at
updated_at

8.5 inventory_balances

Stores the current stock balance for each product at each branch.

inventory_balances
------------------
id
branch_id
product_id
quantity_on_hand
quantity_reserved
updated_at


Create a unique constraint on (branch_id, product_id) so each product has only one balance record per branch.

Use suitable numeric types for quantities if the company tracks fractional units, weights, or volumes.

8.6 inventory_transactions

Stores stock movement records.

inventory_transactions
----------------------
id
transaction_number
transaction_type
branch_id
product_id
quantity_change
quantity_before
quantity_after
reason
reference_number
created_by
approved_by
status
created_at
approved_at
notes


For transfers, link the sending and receiving branches using a dedicated transfer record or additional source and destination fields.

For transactions containing multiple products, use a transaction header and separate transaction-line records instead of creating unrelated records.

8.7 stock_transfers

Stores transfers between branches.

stock_transfers
---------------
id
transfer_number
from_branch_id
to_branch_id
status
requested_by
approved_by
created_at
approved_at
dispatched_at
received_at
received_by
notes


A separate stock_transfer_items table should store the products and quantities in each transfer.

8.8 inventory_adjustments

Stores physical-count corrections.

inventory_adjustments
---------------------
id
branch_id
product_id
system_quantity
counted_quantity
difference
reason
requested_by
approved_by
status
created_at
approved_at
notes


Once approved, an adjustment should generate the appropriate inventory transaction.

8.9 audit_logs

Stores security and business audit events.

audit_logs
----------
id
user_id
action
entity_type
entity_id
branch_id
details
created_at
request_id


For inventory investigations, the detailed audit record should also link to the transaction ID and include the relevant stock quantities.

Audit records should be written through trusted backend logic, with suitable retention and access controls.

9. Example API Endpoints

If the project uses a REST API, the following endpoints are a starting point.

Authentication
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me

Branches
GET  /api/branches
POST /api/branches
GET  /api/branches/{branchId}
PUT  /api/branches/{branchId}

Products
GET  /api/products
POST /api/products
GET  /api/products/{productId}
PUT  /api/products/{productId}

Inventory
GET  /api/inventory?branchId=all
GET  /api/inventory?branchId=BRANCH-001
GET  /api/inventory?branchId=BRANCH-001&search=rice
GET  /api/inventory/{productId}/history?branchId=BRANCH-001
POST /api/inventory/receive
POST /api/inventory/release
POST /api/inventory/adjustments


The API must interpret all as all branches the authenticated user is authorized to access. It must not return every company's inventory to any authenticated user by default.

Transfers
POST /api/transfers
POST /api/transfers/{transferId}/approve
POST /api/transfers/{transferId}/dispatch
POST /api/transfers/{transferId}/receive
GET  /api/transfers

Reports and Audit Logs
GET /api/reports/inventory
GET /api/reports/discrepancies
GET /api/audit-logs
GET /api/audit-logs?branchId=BRANCH-001
GET /api/audit-logs?productId=PRODUCT-001


All endpoints must enforce authentication, authorization, input validation, and appropriate logging.

10. Flutter Application Structure

A maintainable project structure could look like this:

lib/
├── main.dart
├── app.dart
│
├── core/
│   ├── constants/
│   ├── errors/
│   ├── network/
│   ├── security/
│   └── utils/
│
├── models/
│   ├── user.dart
│   ├── branch.dart
│   ├── product.dart
│   ├── inventory_balance.dart
│   ├── inventory_transaction.dart
│   └── stock_transfer.dart
│
├── services/
│   ├── auth_service.dart
│   ├── branch_service.dart
│   ├── product_service.dart
│   ├── inventory_service.dart
│   ├── transfer_service.dart
│   └── audit_service.dart
│
├── repositories/
│   ├── inventory_repository.dart
│   ├── product_repository.dart
│   └── branch_repository.dart
│
├── providers/
│   ├── auth_provider.dart
│   ├── branch_provider.dart
│   └── inventory_provider.dart
│
├── screens/
│   ├── login/
│   ├── dashboard/
│   ├── inventory/
│   ├── products/
│   ├── branches/
│   ├── transactions/
│   ├── transfers/
│   ├── discrepancies/
│   ├── audit_logs/
│   └── settings/
│
└── widgets/
    ├── branch_dropdown.dart
    ├── inventory_card.dart
    ├── inventory_table.dart
    ├── stock_status_badge.dart
    └── loading_indicator.dart


Choose a state-management approach such as Riverpod, Bloc, or Provider. Keep API calls and business rules outside the UI widgets.

11. Example Flutter Branch Dropdown

This example demonstrates the branch selection UI. It uses sample data and local state; it is not connected to a backend.

import 'package:flutter/material.dart';

class Branch {
  final String id;
  final String name;

  const Branch({
    required this.id,
    required this.name,
  });
}

class BranchDropdown extends StatelessWidget {
  final List<Branch> branches;
  final String selectedBranchId;
  final ValueChanged<String> onChanged;

  const BranchDropdown({
    super.key,
    required this.branches,
    required this.selectedBranchId,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      value: selectedBranchId,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: 'Select Branch',
        border: OutlineInputBorder(),
      ),
      items: branches.map((branch) {
        return DropdownMenuItem<String>(
          value: branch.id,
          child: Text(branch.name),
        );
      }).toList(),
      onChanged: (value) {
        if (value != null) {
          onChanged(value);
        }
      },
    );
  }
}


Example initialization:

const branches = [
  Branch(id: 'all', name: 'All Branches'),
  Branch(id: 'BR001', name: 'Manila Branch'),
  Branch(id: 'BR002', name: 'Quezon City Branch'),
  Branch(id: 'BR003', name: 'Cebu Branch'),
];

String selectedBranchId = 'all';


When the selection changes, the screen should request inventory for the selected branch or authorized branch set.

For production, manage the selected branch in the application's state-management layer rather than relying on a local variable in a widget.

The backend must validate the selected branch and the user's access rights on every request.

12. Inventory Query and Branch Filtering

When using PostgreSQL, the backend can retrieve inventory using a query similar to the following.

SELECT
    b.branch_code,
    b.branch_name,
    p.id AS product_id,
    p.sku,
    p.product_name,
    i.quantity_on_hand,
    i.quantity_reserved,
    i.quantity_on_hand - i.quantity_reserved
        AS available_quantity
FROM inventory_balances i
JOIN branches b ON b.id = i.branch_id
JOIN products p ON p.id = i.product_id
WHERE
    p.status = 'active'
    AND (
        :branch_id IS NULL
        OR i.branch_id = :branch_id
    )
ORDER BY
    p.product_name,
    b.branch_name;


Here, a null branch_id means all branches within the authenticated user's authorized scope. A specific branch ID filters the results to that branch.

The application must not trust a client-supplied branch ID as proof of permission.

For a dashboard that summarizes total stock by product, aggregate the authorized branch balances:

SELECT
    p.id AS product_id,
    p.sku,
    p.product_name,
    SUM(i.quantity_on_hand) AS total_quantity
FROM inventory_balances i
JOIN products p ON p.id = i.product_id
JOIN branches b ON b.id = i.branch_id
WHERE p.status = 'active'
GROUP BY
    p.id,
    p.sku,
    p.product_name
ORDER BY p.product_name;


In production, apply the user's permitted branch scope before aggregating so unauthorized branches are never included in the result.

13. Inventory Transaction Rules

The backend must be responsible for changing inventory quantities.

For a normal stock release:

Authenticate the user.
Check access to the branch.
Validate the requested product and quantity.
Check available stock.
Start a database transaction.
Lock or safely update the relevant inventory balance.
Create the stock transaction record.
Update the inventory balance.
Write the audit event.
Commit the transaction.

If any required step fails, roll back the operation.

Use database transactions and concurrency controls to prevent two simultaneous requests from releasing the same stock twice.

Every transaction request should also have an idempotency mechanism or unique request reference so that retries do not accidentally duplicate stock movements.

Never rely exclusively on Flutter to calculate and save the new stock balance. The server must validate and perform the operation.

14. Reports

The system should provide the following reports.

Inventory Reports
Current inventory by branch.
Total inventory across authorized branches.
Product stock valuation, where appropriate.
Low-stock products.
Out-of-stock products.
Inventory movement history.
Stock received and released within a date range.
Management and Investigation Reports
Stock adjustment report.
Inventory discrepancy report.
Unapproved transaction report.
Branch transfer report.
User transaction activity.
Repeated stock discrepancy report.
Audit trail filtered by branch, product, user, action, and date.

Allow authorized users to export CSV or PDF reports.

Reports should use consistent time zones and clearly display the selected date range, branch scope, and generation time.

15. Security Requirements

Because the system may be used to investigate missing products, security must be part of the initial design.

Required controls:

Individual user accounts.
Role-based access control.
Branch-specific permissions.
Server-side authorization.
HTTPS for network communication.
Secure password and session handling.
Audit logging for sensitive actions.
Approval for significant inventory adjustments.
Validation of all inventory transactions.
Database backups and recovery testing.
Rate limiting and protection against repeated login attempts.
Restricted access to reports and sensitive user information.
Secure handling of exported reports.
Appropriate data retention and deletion policies.

For high-risk actions, consider requiring a manager's approval or re-authentication.

Avoid storing sensitive credentials directly in application code or ordinary local preferences.

A device should not be treated as trusted merely because it has the official app installed.

16. Offline Support

If branches sometimes have unreliable internet access, offline support may be useful.

However, offline inventory changes introduce additional risks because different devices may modify the same stock before synchronizing.

Recommended initial approach:

Allow cached inventory to be viewed offline, with a clear last-updated timestamp.
Require an internet connection for stock releases, transfers, and adjustments.
If offline transactions are later required, queue them with unique transaction IDs and reconcile them through the backend.
Never overwrite server balances with an old locally cached quantity.
Clearly distinguish pending, synchronized, and rejected transactions.

For a first production release, online-only inventory changes are generally simpler and safer.

17. Development Roadmap
Phase 1: Planning and Design
Confirm the company's branches and user roles.
Define product fields and inventory units.
Establish transaction types and adjustment rules.
Design database relationships.
Create wireframes for the login, dashboard, and inventory screens.
Phase 2: Authentication and Setup
Create the Flutter project.
Configure the backend and database.
Implement authentication.
Create branch and user management.
Implement role-based access control.
Phase 3: Core Inventory
Implement product management.
Implement the inventory list.
Create the All Branches dropdown.
Implement branch-specific filtering.
Add search, categories, and stock status filters.
Implement stock receiving and release.
Phase 4: Traceability and Controls
Implement transaction history.
Implement audit logs.
Add branch transfers.
Add physical stock counts and adjustment approvals.
Add discrepancy detection and investigation reports.
Phase 5: Reports and Testing
Implement CSV/PDF exports.
Test role permissions.
Test simultaneous stock transactions.
Test network failures and retries.
Verify that audit records cannot be changed by ordinary users.
Test database backups and recovery.
Phase 6: Deployment
Deploy the backend using secure production settings.
Build the Android application.
Create administrator accounts.
Register company branches and products.
Train staff and managers.
Pilot the system at one branch.
Roll out to the remaining branches after validation.
18. Testing Checklist
Branch Filtering
All Branches displays all authorized branch inventory.
Selecting one branch displays only its inventory.
Dashboard totals change when the branch changes.
Searching works with branch filtering.
Unauthorized branch IDs are rejected by the backend.
Branch names can change without breaking inventory references.
Stock Transactions
Receiving increases the correct branch's stock.
Releasing decreases the correct branch's stock.
A release cannot exceed available stock.
Transfers record both source and destination.
Failed transactions do not create inconsistent balances.
Repeated requests do not duplicate transactions.
Concurrent releases are handled safely.
Audit and Security
Every completed inventory change has an audit record.
The record identifies the account and timestamp.
The previous and new stock quantities can be reconstructed.
Staff cannot modify audit records.
Managers can approve or reject adjustments according to their permissions.
Deactivated accounts cannot continue making requests.
Reports exclude branches the user is not permitted to access.
Reporting
Inventory totals match the branch balances.
Date filters use the intended time zone.
Exported reports match the displayed results.
Discrepancies can be traced to their underlying transactions.
19. Recommended Minimum Viable Product (MVP)

To avoid building too many features at once, the first version should focus on:

Login and user roles.
Branch management.
Product management.
Inventory list.
All Branches and specific-branch dropdown.
Stock receiving and release.
Inventory transaction history.
Audit logs.
Physical stock count and adjustment approval.
Basic discrepancy reports.

After these features are working correctly, add branch transfers, barcode scanning, push notifications, advanced analytics, and more detailed reporting.

20. Final Recommendation

Build the application around a centralized inventory database with one balance per product per branch.

Use Flutter for the Android interface, and enforce inventory rules through a secure backend.

The most important design decisions are:

Every staff member uses an individual account.
Each user has explicitly defined branch permissions.
Every inventory movement creates a transaction record.
Stock quantities are updated atomically on the server.
Inventory corrections require a recorded reason and appropriate approval.
Audit logs preserve the history of stock changes.
Discrepancy reports help management investigate missing stock using documented evidence.

This design will provide a reliable foundation for monitoring products across branches, identifying unusual stock movements, and improving accountability throughout the company.

Document Status: Initial project specification
Next Step: Confirm the backend technology, database, number of branches, and user roles before beginning implementation.