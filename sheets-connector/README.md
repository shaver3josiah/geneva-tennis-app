# Geneva Tennis: Google Sheets connector

Set this up once, about 3 minutes. After that every match you chart gets its own Google Sheet
in your Drive, filled in point by point, with a formatted summary.

You need a Google account (the sheets will be created in its Drive) and the code in `Code.gs`,
the file next to this one.

## Set up

1. Open https://script.new while signed in to the Google account that should own the sheets.
   (Or open any Google Sheet and choose Extensions > Apps Script.) A new project opens.
2. Click the project name at the top ("Untitled project") and rename it to Geneva Tennis. Delete
   the few lines of sample code in the editor, then paste in all of `Code.gs`.
3. Near the top, change `const TOKEN = 'CHANGE-ME';` to a secret of your own, for example
   `const TOKEN = 'geneva-9f3k2x';`. Keep the quotes. Press Ctrl+S (Cmd+S on a Mac) to save.
   You will paste this same word into the app in step 8.
4. Click Deploy (top right) > New deployment.
5. Click the gear next to "Select type" and choose Web app. Then set:
   - Description: Geneva Tennis
   - Execute as: Me
   - Who has access: Anyone
6. Click Deploy. Google asks you to authorize access: click Authorize access and pick your
   account.
7. You will see a screen that says "Google hasn't verified this app". This is normal: you wrote
   (pasted) the script yourself and it has not been through Google's review. Click Advanced, then
   "Go to Geneva Tennis (unsafe)", then Allow. The script only creates and edits spreadsheets
   in your own Drive and reads your email address to show you that it is connected.
8. Copy the Web app URL. It ends in `/exec`. In the Geneva Tennis app open
   Matches > Google Sheets, paste the URL, type the same token you chose in step 3, and tap
   Test connection. It should show your Google account's email address.

That is all. Chart a match and its sheet appears in your Drive named "Geneva Tennis — match
name (date)". The first update of a match takes a few seconds while the new sheet is formatted.

## Good to know

- "Who has access: Anyone" only means the URL can be reached. Nothing happens without the token,
  so keep the token private: anyone who has both the URL and the token can create sheets in your
  Drive. If it leaks, change `TOKEN`, save, and redeploy (see below), then update the app.
- Each match is its own spreadsheet. Points are matched by their number (column A), so correcting
  a point replaces its row instead of adding a copy. Do not type in the Points and Summary tabs:
  the next update overwrites them. Copy the sheet to add your own notes.
- If you delete a match's spreadsheet, the next update makes a fresh one.

## Updating the script later

When the app tells you a newer connector is available, or after you change `TOKEN`:

1. Paste the new `Code.gs` over the old one, put your `TOKEN` back, and save.
2. Deploy > Manage deployments, click the pencil, set Version to "New version", click Deploy.
   The URL stays the same. (Do not pick New deployment, that makes a different URL.)

## If something goes wrong

- "bad token": the token in the app is not the same as the one in the script. Check the spelling
  and that you saved and redeployed after editing it.
- "Edit TOKEN in Code.gs": the token is still `CHANGE-ME`. Do step 3, then redeploy.
- The test fails or returns a Google sign-in page: open Deploy > Manage deployments and check
  that "Who has access" is Anyone and "Execute as" is Me, then deploy a new version.
- "Exception: You do not have permission": run any function once from the editor (choose `doGet`
  in the toolbar and press Run) and accept the permissions, then redeploy.
