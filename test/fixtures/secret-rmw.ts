// Read-modify-write of the secrets file with a pause between the read and the
// write, so that an unlocked implementation loses updates deterministically.
// usage: bun secret-rmw.ts <secrets.json path> <name> <value>
import { readSecrets, withSecretsLock, writeSecrets } from "../../cli/commands/secret.ts";

const [path, name, value] = process.argv.slice(2) as [string, string, string];
withSecretsLock(() => {
  const file = readSecrets(path);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  file.secrets[name] = value;
  writeSecrets(file, path);
}, path);
