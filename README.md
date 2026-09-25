# Celonis ERD Explorer

Explore your Celonis data pool as an interactive diagram. See which tables connect, inspect their columns and keys, trace join paths, and leave notes on the canvas. You can also run PQL queries or save a diagram to reopen and share later.

Your layouts and notes stay in your browser. They do not change the data model in Celonis.

## Install

Install with uv, using Python 3.13 or later:

```bash
uv tool install git+https://github.com/FBarrca/erd-celonis
```

If your terminal does not recognize `erd-celonis`, run `uv tool update-shell`, then reopen the terminal.

## Open a data pool

To connect to Celonis, create a file named `.env` in the folder where you will run the command:

```dotenv
CELONIS_URL=https://your-tenant.celonis.cloud
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_SCOPES=your-scopes
```

Use the OAuth credentials and scopes provided by your Celonis administrator, with access to the data pool you want to explore. This setup is only needed when loading from Celonis or running queries.

Start the explorer with your data pool ID:

```bash
erd-celonis "<data-pool-id>"
```

Your browser opens at `http://127.0.0.1:8000`. Keep the terminal running while you use the app; press **Ctrl+C** in the terminal to stop it.

All models in the pool are loaded. Use the **Data model** selector in the header to switch between them. To load just one model:

```bash
erd-celonis "<data-pool-id>" "<data-model-id>"
```

## Explore the diagram

| To… | Do this |
| --- | --- |
| Move around | Drag empty canvas space or use two-finger trackpad scrolling. |
| Zoom | Pinch on your trackpad or use the +/− controls. Use **Fit View** to recenter. |
| Arrange tables | Drag a table to a new position. |
| Find a table or column | Use the header search. It also matches approximate names. The **T** button restricts results to tables. |
| Inspect a table | Click its heading to see all columns, primary keys, and connected tables. |
| Inspect a relationship | Click a connecting line to see the join columns. |
| Trace a connection | Select a table, choose **Find connection to…**, then select a destination. |

Connections reflect the foreign keys configured in Celonis. The path finder highlights a shortest route through those relationships; it does not guarantee that a particular PQL join is valid.

## Add notes

Click the yellow note icon on the canvas, or press **N** with your pointer over the canvas to place a note there.

Give the note a title and type in its body. Markdown syntax highlighting helps you organize headings, lists, links, and code. Drag the dotted header grip to move it, and click **×** to delete it.

Each model has its own notes and layout. Table positions, notes, pan, zoom, and your selected model save automatically in the browser.

## Save, share, and reopen

The two icons immediately to the right of the **Data model** selector import and export datapool state. Hover over either icon to see its name.

1. Click **Export datapool** (down arrow) to download a `.erd.json` file.
2. Keep it as a backup or share it with someone who needs the diagram.
3. Click **Import datapool** (up arrow) to open a saved file.

An export includes **all loaded models**, with their tables, columns, keys, relationships, table positions, note titles and text, pan/zoom, and selected model. Credentials, PQL drafts, and query results are not included. Import restores the saved diagram and replaces the layouts and notes for that pool.

To open a saved file without connecting to Celonis, start the app without an ID:

```bash
erd-celonis
```

Then use **Import datapool**. You can explore the schema, rearrange tables, and edit notes without Celonis credentials. The last imported diagram reopens automatically when you return to the same browser address.

Automatic saves belong to the **same browser profile, address, and port**. Switching browsers or ports, using `localhost` instead of `127.0.0.1`, or clearing browser data changes which saves are available. Export your work to keep a portable backup, and export again after making changes. Files can be up to 25 MB.

## Run PQL queries

Start the app with a data pool ID to use the **PQL console** at the bottom. Queries run against the model selected in the header, using your Celonis permissions.

Choose **Load example** to start with fields from your model, or write a query such as:

```pql
TABLE(
  "Orders"."CUSTOMER_ID" AS "Customer",
  SUM("Orders"."AMOUNT") AS "Total amount"
);
```

Replace the table and column names with your own. Use **Insert table or column** or the editor's suggestions to find available fields. Add `FILTER ...;` statements to narrow the result. The console uses PQL `TABLE(...)` syntax, rather than SQL `SELECT`.

Click **Run**, or press **Ctrl+Enter** (**Cmd+Enter** on macOS). Adjust **Limit** to control the returned rows, up to 10,000. Click result column headings to sort, and choose **Download CSV** to save the results.

Drag the console's top edge to resize it, or use its expand and collapse buttons. Query drafts save per model in your browser; results are cleared when you switch models or reload. Imported diagrams do not offer query execution.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **/** | Focus table and column search. |
| **Ctrl+G** / **Cmd+G** | Focus table-only search; press again while searching to toggle it. |
| **N** | Add a note centered on the pointer when it is over the canvas. |
| **Ctrl+Enter** / **Cmd+Enter** | Run the query while focused in the PQL console. |
| **Ctrl+Space** | Show PQL autocomplete suggestions. |

The **/** and **N** shortcuts are inactive while you are typing in an editor or input field.

## Other useful commands

```bash
# Use another port if the default is occupied
erd-celonis "<data-pool-id>" --port=8123

# Start without opening a browser automatically
erd-celonis "<data-pool-id>" --open_browser=False

# Load tables and relationships without fetching columns
erd-celonis "<data-pool-id>" --include_columns=False

# Save a SQL-like description of the schema as text
erd-celonis "<data-pool-id>" --ddl > schema.sql
```

The text export describes tables, columns, and keys; it is not a backup of your layout or notes. Use **Export datapool** for that.

To pick up schema changes made in Celonis, stop the app and run the command again.
