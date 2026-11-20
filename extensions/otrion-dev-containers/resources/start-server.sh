#!/bin/sh
# Executed as the dev container's remoteUser, with its configured environment.
set -eu
umask 077
commit=$1
version=$2
name=$3
archive=$4
window_key=$5
case "$(uname -s)/$(uname -m)" in
	Linux/x86_64) arch=x64 ;;
	Linux/aarch64|Linux/arm64) arch=arm64 ;;
	*) echo 'Otrion requires a Linux x64 or ARM64 container.' >&2; exit 1 ;;
esac
if [ -f /etc/alpine-release ]; then
	echo 'Use a glibc-based image. Otrion does not publish an Alpine server.' >&2
	exit 1
fi
base="$HOME/.otrion-server/bin"
mkdir -p "$base"
dir="$base/${commit:-dev-$version}"
verify() {
	[ -x "$1/bin/$name" ] && "$1/node" -e '
	const p = require(process.argv[1]);
	process.exit(p.otrionVersion === process.argv[2] && (!process.argv[3] || p.commit === process.argv[3]) ? 0 : 1)
	' "$1/product.json" "$version" "$commit"
}
if [ "$archive" = probe ]; then
	if verify "$dir"; then
		printf 'ready'
	else
		printf '%s\n' "$arch"
		mktemp "${TMPDIR:-/tmp}/otrion-archive.XXXXXXXX"
	fi
	exit 0
fi
if ! verify "$dir"; then
	stage=$(mktemp -d "$base/.install.XXXXXXXX")
	trap 'rm -rf "$stage"' EXIT
	mkdir "$stage/server"
	tar -xzf "$archive" -C "$stage/server" --strip-components=1
	verify "$stage/server" || { echo 'The downloaded server does not match this Otrion build.' >&2; exit 1; }
	mv -T "$stage/server" "$dir" 2>/dev/null || verify "$dir" || { echo "Invalid server installation at $dir" >&2; exit 1; }
fi
record=
if [ -n "$window_key" ]; then
	case "$window_key" in *[!0-9a-f]*) exit 1 ;; esac
	mkdir -p "$dir/.connections"
	record="$dir/.connections/$window_key"
	if [ -f "$record" ] && "$dir/node" -e '
		const fs = require("node:fs");
		const endpoint = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		process.kill(endpoint.pid, 0);
		const socket = require("node:net").connect(endpoint.port, "127.0.0.1");
		socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
		socket.on("error", () => { process.exitCode = 1; });
		socket.on("connect", () => { console.log(JSON.stringify(endpoint)); socket.destroy(); });
	' "$record" 2>/dev/null; then
		exit 0
	fi
fi
session=$(mktemp -d "${TMPDIR:-/tmp}/otrion-container.XXXXXXXX")
"$dir/node" -e 'process.stdout.write(require("node:crypto").randomUUID())' > "$session/token"
nohup "$dir/bin/$name" --start-server --host=127.0.0.1 --port=0 --connection-token-file "$session/token" --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms </dev/null >"$session/server.log" 2>&1 &
pid=$!
i=0
while [ "$i" -lt 60 ]; do
	port=$(sed -n 's/^.*Extension host agent listening on \([0-9][0-9]*\).*$/\1/p' "$session/server.log" | head -1)
	if [ -n "$port" ]; then
		"$dir/node" -e '
			const fs = require("node:fs");
			const [port, file, pid, record] = process.argv.slice(1);
			const endpoint = JSON.stringify({node:process.execPath, port:Number(port), pid:Number(pid), token:fs.readFileSync(file, "utf8")});
			if (record) {
				const temp = record + "." + pid;
				fs.writeFileSync(temp, endpoint, { mode: 0o600 });
				fs.renameSync(temp, record);
			}
			console.log(endpoint);
		' "$port" "$session/token" "$pid" "$record"
		exit 0
	fi
	kill -0 "$pid" 2>/dev/null || break
	i=$((i + 1))
	sleep 1
done
kill "$pid" 2>/dev/null || true
echo "Otrion server failed to start. See $session/server.log in the container." >&2
exit 1
