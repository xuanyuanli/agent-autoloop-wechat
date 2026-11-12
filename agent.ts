// The same folder is also the Cursor CLI agent: it keeps the chat id so a later
// WeChat message continues the conversation instead of starting a blank one.
import { checkCursor, commandLine, readOutput } from "./src/cursor.ts";

export default {
  command: commandLine,
  read: readOutput,
  check: (program?: string) => checkCursor(program),
};
