You are improving yourself, one roadmap item at a time. Do exactly these steps with tool calls. Do not ask me anything.

1. read_file ~/llmcli/ROADMAP.md. Find the FIRST line that starts with "- [ ]". That is your item. Ignore lines starting with "- [x]" or "- [!]". Read its indented description lines too.
2. If there is no "- [ ]" line, reply exactly: ALL DONE
3. read_file ~/llmcli/llmcli.ts in pieces (offset and limit 200) and find where the change belongs.
4. Implement ONLY that item with small edits. Prefer insert_lines / replace_lines with the line numbers from read_file. Every edit to llmcli.ts is compile-checked and boot-tested automatically; if you get REVERTED, read the error, fix your edit, and try again. Re-read the region after each successful edit because the line numbers move.
5. Run the item's check command from the roadmap with run_bash (working directory is already ~/llmcli). If it fails, fix the problem and run it again.
6. Only when the check passes: edit_file ~/llmcli/ROADMAP.md and change that item's "- [ ]" to "- [x]". Use old_string "- [ ] <the item title>" and new_string "- [x] <the item title>".
7. Reply with one line: the item title and DONE. If you could not finish, reply BLOCKED and the reason, and leave the item unchecked.
