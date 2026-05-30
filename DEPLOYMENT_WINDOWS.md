# MailFlow — AWS EC2 (Windows Server) Deployment Guide

Use this guide to deploy `MailFlow` to an AWS EC2 Windows Server instance (Free Tier eligible) so the app runs 24/7 and sends mail even when your laptop is off.

Overview:
- Launch an EC2 Windows Server instance (t2.micro free-tier). Connect via RDP.
- Install Node.js, PostgreSQL, Git, and IIS (to serve frontend + reverse-proxy to backend).
- Configure the database and enable `pgcrypto` (required by `backend/src/schema.sql`).
- Upload or clone the code, set `.env`, install dependencies, build frontend, and run the backend as a Windows service (NSSM) or using PM2+service.

Important: Linux (Ubuntu) is still the simplest server environment. Choose Windows only if you must use Windows AMIs.

Prerequisites
- An AWS account (Free Tier eligible).
- RDP client (Windows: Remote Desktop; macOS: Microsoft Remote Desktop).
- The MailFlow repo available locally or in a Git host.

Step 0 — Prepare: decide hostname/IP
- If you have a domain, point it to the EC2 public IP or use AWS Elastic IP for a stable address.

1) Launch EC2 — Windows Server (Free Tier)
1. In AWS Console → EC2 → Launch Instance.
2. Choose AMI: "Microsoft Windows Server 2022 Base" (or 2019) — free-tier eligible images exist.
3. Instance type: `t2.micro` (Free Tier).
4. Key pair: create or use existing (you will decrypt the Administrator password with the key).
5. In "Configure Security Group" add inbound rules:
   - RDP (TCP 3389) — restrict to your IP initially.
   - HTTP (TCP 80) — Source: 0.0.0.0/0
   - HTTPS (TCP 443) — Source: 0.0.0.0/0 (optional)
   - Custom TCP 4000 — Source: 127.0.0.1/32 (if you only proxy via IIS) or 0.0.0.0/0 if you need direct access.
6. Launch and wait for it to start.

2) Connect via RDP
1. Select the instance → Actions → Get Windows Password. Decrypt with your key pair to obtain Administrator password.
2. Use Remote Desktop to connect to `Administrator@PUBLIC_IP` and paste the password.

3) Install tooling on the Windows instance (PowerShell as Administrator)
You can use Chocolatey (recommended) or manual installers.

Install Chocolatey (one-time):

Open PowerShell as Administrator and run:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
```

Install packages (PowerShell):

```powershell
choco install -y nodejs-lts git postgresql nginx
# Optional: install 7zip, notepadplusplus, etc.
```

Notes:
- `choco install postgresql` installs Postgres and a password for the `postgres` user; follow prompts and record the password.
- If Postgres installer requires interactive setup, follow it.

4) Configure PostgreSQL and `pgcrypto`
1. Open `psql` (run as the postgres superuser). If installed via Chocolatey, you can run:

```powershell
& "C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres
```

2. Inside `psql` run:

```sql
CREATE DATABASE mailflow;
CREATE USER mailflow_user WITH ENCRYPTED PASSWORD 'YOUR_DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mailflow TO mailflow_user;
\c mailflow
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

Adjust the `psql` binary path/version as installed on the instance.

5) Prepare Windows firewall (open ports if necessary)
Use Windows Defender Firewall → Advanced settings, add inbound rules for:
- Port 80 (HTTP)
- Port 443 (HTTPS) if using certs
- If you opted to run backend directly accessible, open 4000 (or better: keep 4000 local and proxy via IIS)

6) Get the app code onto the server
Option A: Clone from Git

```powershell
cd C:\inetpub\wwwroot
git clone <your-repo-url> mailflow
cd mailflow\backend
```

Option B: Upload via SCP/WinSCP and extract into `C:\inetpub\wwwroot\mailflow`.

7) Backend: configure and run
1. Create a `.env` in `C:\inetpub\wwwroot\mailflow\backend` with values (edit accordingly):

```
DATABASE_URL=postgresql://mailflow_user:YOUR_DB_PASSWORD@localhost:5432/mailflow
JWT_SECRET=long_random_secret_here
GMAIL_CLIENT_ID=...apps.googleusercontent.com
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=http://YOUR_DOMAIN_OR_IP:4000/api/auth/gmail/callback
BACKEND_URL=http://YOUR_DOMAIN_OR_IP:4000
FRONTEND_URL=http://YOUR_DOMAIN_OR_IP
NODE_ENV=production
PORT=4000
```

2. Install dependencies (PowerShell):

```powershell
cd C:\inetpub\wwwroot\mailflow\backend
npm install --production
```

3. Test the backend locally:

```powershell
node src\index.js
```

Open `http://localhost:4000/health` in the server browser to verify.

4. Run backend as a Windows Service (two options):

Option A — NSSM (recommended lightweight):
 - Download NSSM (Non-Sucking Service Manager) and extract to `C:\nssm`.
 - Install service:

```powershell
& C:\nssm\nssm.exe install MailFlowBackend "C:\Program Files\nodejs\node.exe" "C:\inetpub\wwwroot\mailflow\backend\src\index.js"
& C:\nssm\nssm.exe set MailFlowBackend AppDirectory C:\inetpub\wwwroot\mailflow\backend
& C:\nssm\nssm.exe set MailFlowBackend Start SERVICE_AUTO_START
& C:\nssm\nssm.exe start MailFlowBackend
```

Option B — PM2 + pm2-windows-service (if you prefer pm2):

```powershell
npm install -g pm2 pm2-windows-service
pm2 start src/index.js --name mailflow-backend
pm2 save
pm2-service-install -n pm2-service
```

8) Confirm service is running: open Services.msc and look for `MailFlowBackend` or check pm2 list.

8) Backend logs: Use the Windows Event Viewer (if NSSM configured to log) or tail log files if your app writes them. If using PM2, use `pm2 logs`.

8) Note: `initDB()` runs on server start and applies `backend/src/schema.sql`. If schema failed previously, run:

```powershell
& "C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -d mailflow -f "C:\inetpub\wwwroot\mailflow\backend\src\schema.sql"
```

8) If `gen_random_uuid()` errors occur, ensure `CREATE EXTENSION pgcrypto;` was created in the `mailflow` database (see step 4).

8) For maintenance, use `nssm` to stop/start the service or Windows Services UI.

8) If your backend needs to reach Gmail APIs, ensure outbound TLS (HTTPS) is allowed — by default outbound is allowed.

8) If Postgres is installed on another host, update `DATABASE_URL` accordingly and ensure port 5432 is reachable.

8) Security reminder: do not open Postgres port to the world.

8) Replace `C:\Program Files\PostgreSQL\14` paths with your installed version paths.

8) If you prefer containers, you can run Postgres + Node in Docker on Windows Server with Docker installed — that is an advanced option.

8) Frontend: build and serve via IIS
1. Install IIS and URL Rewrite + Application Request Routing (ARR):
   - Server Manager → Add roles and features → Web Server (IIS).
   - Install URL Rewrite and ARR (download installers or use Web Platform Installer).

2. Build frontend:

```powershell
cd C:\inetpub\wwwroot\mailflow\frontend
echo "REACT_APP_API_URL=http://YOUR_DOMAIN_OR_IP/api" > .env
npm install
npm run build
```

3. Create a new IIS website (or use Default Web Site) with physical path `C:\inetpub\wwwroot\mailflow\frontend\build` and binding for port 80.

4. Enable ARR proxy so IIS can forward `/api` to the backend:
   - In IIS Manager → Server level → Application Request Routing → Server Proxy Settings → Enable proxy.
   - Add a rewrite rule (URL Rewrite) that matches `^api/(.*)` and rewrites to `http://localhost:4000/api/{R:1}` (preserve query string).

5. Test: open `http://YOUR_DOMAIN_OR_IP` in browser. Frontend should load and API calls proxied to backend.

9) Google OAuth redirect
Update Google Cloud OAuth client redirect URI to:

```
http://YOUR_DOMAIN_OR_IP:4000/api/auth/gmail/callback
```

If you will serve the frontend at `http://YOUR_DOMAIN_OR_IP`, set `FRONTEND_URL` in `.env` to that value.

10) AWS specifics — Elastic IP & Auto-restart
- Allocate and attach an Elastic IP to your instance so IP doesn't change on stop/start.
- Create AMI or snapshot for backup.

11) Troubleshooting
- Health: `http://localhost:4000/health` on the server.
- Logs: Windows Event Viewer, PM2 logs, or files depending on how you run the backend.
- Postgres: use `pgAdmin` locally or `psql` on server.

12) Recommendations
- For production reliability, use Ubuntu server (Linux) on EC2 — lighter and easier to manage.
- Consider RDS (managed Postgres) for production, and a real domain + HTTPS via Let's Encrypt.

If you'd like, I can:
- generate an NSSM install script that automates the service creation, or
- create an IIS URL Rewrite template for the `/api` proxy rule.
