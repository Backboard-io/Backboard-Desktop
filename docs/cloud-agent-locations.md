# Local and EC2 agent locations

The Simple mode **New chat** composer has a location chip below its input,
beside the project folder. **Local** runs a task on this computer. A saved
remote host runs a new task in a folder on that host.

## Connect an existing EC2 agent server

1. Start a compatible Backboard agent server on the EC2 machine, with the
   Backboard runtime and its provider credentials configured there. The host
   must advertise the `backboard` agent. An ordinary SSH server or an EC2
   instance ID alone is not an agent-server endpoint.
2. Make its WebSocket endpoint reachable. For a private server, forward its
   loopback port over SSH or AWS Systems Manager. For example, with an
   existing SSH config alias named `backboard-ec2`:

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8081:127.0.0.1:8081 backboard-ec2
   ```

3. In Simple mode, open **New chat → Local → Connect EC2…**.
4. Enter `ws://127.0.0.1:8081` (or the host's authenticated `wss://` endpoint),
   a display name, and the server's connection token.
5. Select a folder on the remote host. The chip changes to its saved name.
   If the provider is still loading, select the saved host again once connected.

No AWS credentials are needed by the IDE for a connection through an existing
SSH tunnel. An AWS Systems Manager tunnel requires AWS CLI authentication
outside the IDE. Keep the tunnel open while interacting with the host.

The IDE saves the connection using its existing `chat.remoteAgentHosts`
configuration and enables remote hosts on connection. This existing storage
includes the connection token; the masked input does not imply encrypted
storage. Do not share settings containing connection tokens.

## Choose where to work

- Click the location chip to choose Local or a saved remote host.
- Click the folder to browse on the current host.
- Cancelling either dialog leaves the task's current location unchanged.
- **Manage remote hosts…** opens the existing host management interface.
- An unavailable host reports its connection state; selecting it requests a
  reconnect without moving the draft to a different location.

The location applies to new tasks. Existing conversations keep their original
host. Local files are not uploaded automatically: clone or copy the project
onto EC2 first. The model picker uses the Backboard models advertised by the
selected host.

## Server entry point

The server implementation is
`backboard/src/vs/platform/agentHost/node/agentHostServerMain.ts`; its compiled
entry point is `out/vs/platform/agentHost/node/agentHostServerMain.js`.
It accepts `--host`, `--port`, and `--connection-token-file`.

Build the same revision on the host with Linux-compatible native dependencies
and the repository's pinned Node version. Keep the server bound to loopback
when using a tunnel. Do not use `--quiet` for a real Backboard host: that mode
skips production-agent registration. A supervisor must also keep the server's
stdin open: the current server shuts down when stdin reaches EOF.

This UI does not provision EC2, install the server, create SSH/SSM tunnels,
or migrate active tasks. Remote execution and survival across IDE disconnects
still need an end-to-end check against the configured EC2 server.
