/** The SSH backend is authoritative; these guards prevent stale client confirmations. */
export const MAX_TERMINAL_COMMAND_BYTES=4*1024*1024;

export function validTerminalCommand(command:string):boolean {
  return command.trim().length>0 &&
    new TextEncoder().encode(command).length<=MAX_TERMINAL_COMMAND_BYTES &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command);
}

/** The exact, reviewed multiline text must match the text sent to the API. */
export function confirmedTerminalCommand(
  prepared:string|null,current:string,enabled:boolean,configured:boolean,pending:boolean
):boolean {
  return pending&&prepared!==null&&prepared===current&&
    enabled&&configured&&validTerminalCommand(current);
}
