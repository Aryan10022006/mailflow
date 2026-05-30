# MailFlow — Completely Free Deployment Guide

This guide uses **Oracle Cloud Always Free** for the server and **PostgreSQL on the same VM** so the whole stack can run 24/7 without your laptop being on.

Why this option:
- Oracle Cloud Always Free includes small ARM or AMD VMs that can stay up continuously.
- The app already supports a Linux server, Postgres, Node.js, PM2, and nginx.
- Gmail sending is still handled through your Google account, so there is no email server cost.

What you will use
- 1 always-on VM on Oracle Cloud Free Tier
- Ubuntu Server 22.04 LTS
- Node.js 20
- PostgreSQL on the same VM
- nginx to serve the frontend and proxy API requests

What you need before starting
- A Google account for Gmail API
- An Oracle Cloud account
- Your MailFlow repo locally or in GitHub

---

## 1) Set up Gmail API in Google Cloud

1. Open https://console.cloud.google.com
2. Create a new project named `MailFlow`
3. Go to `APIs & Services` → `Library`
4. Search for `Gmail API` and enable it
5. Go to `OAuth consent screen`
6. Choose `External`
7. Fill in app name and support email
8. Add your Gmail address as a test user
9. Go to `Credentials` → `Create Credentials` → `OAuth client ID`
10. Choose `Web application`
11. Add this redirect URI for now. You will replace `YOUR_PUBLIC_IP_OR_DOMAIN` later:

```text
http://YOUR_PUBLIC_IP_OR_DOMAIN:4000/api/auth/gmail/callback
```

12. Save the Client ID and Client Secret

---

## 2) Create the free Oracle Cloud VM

Oracle changes its console UI from time to time, but the flow is the same.

1. Sign in to https://www.oracle.com/cloud/free/
2. Create an `Always Free` compute instance
3. Choose Ubuntu Server 22.04 LTS
4. If available, choose an `Ampere` always-free shape or another always-free eligible shape
5. Attach or create an SSH key pair and download the private key
6. Make sure the boot volume is within always-free limits
7. Finish instance creation and wait for it to boot

Important network rules:
- Allow inbound `22` from your IP for SSH
- Allow inbound `80` from anywhere for the website
- Allow inbound `443` from anywhere if you want HTTPS
- Do **not** expose PostgreSQL port `5432` to the internet

If Oracle asks about VCN or subnet security lists, open ports 22, 80, and 443 there too.

---

## 3) Connect to the VM

From Windows PowerShell or a terminal on your computer:

```powershell
ssh -i C:\path\to\your_oracle_key.pem ubuntu@YOUR_PUBLIC_IP
```

If you use PuTTY, convert the key if needed and connect as `ubuntu@YOUR_PUBLIC_IP`.

---

## 4) Install the server software

Run these commands on the Oracle VM:

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# PM2 to keep the app running
sudo npm install -g pm2

# nginx for the web server
sudo apt install -y nginx

# Optional but recommended
sudo apt install -y git ufw
```

Check versions:

```bash
node --version
psql --version
```

---

## 5) Prepare PostgreSQL

The app schema uses `gen_random_uuid()`, so `pgcrypto` must be enabled.

```bash
sudo -u postgres psql
```

Inside `psql` run:

```sql
CREATE DATABASE mailflow;
CREATE USER mailflow_user WITH ENCRYPTED PASSWORD 'CHOOSE_A_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mailflow TO mailflow_user;
\c mailflow
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

If you want to verify manually later, you can always run the schema file against the `mailflow` database.

---

## 6) Put the code on the VM

Option A: clone from GitHub on the VM

```bash
cd ~
git clone <your-repo-url> mailflow
cd mailflow
```

Option B: copy the repo using `scp` from your computer

```powershell
scp -i C:\path\to\your_oracle_key.pem -r backend ubuntu@YOUR_PUBLIC_IP:/home/ubuntu/mailflow-backend
scp -i C:\path\to\your_oracle_key.pem -r frontend ubuntu@YOUR_PUBLIC_IP:/home/ubuntu/mailflow-frontend
```

The rest of the guide assumes this structure:

- `/home/ubuntu/mailflow-backend`
- `/home/ubuntu/mailflow-frontend`

---

## 7) Configure the backend

Create `/home/ubuntu/mailflow-backend/.env`:

```text
DATABASE_URL=postgresql://mailflow_user:YOUR_DB_PASSWORD@localhost:5432/mailflow
JWT_SECRET=make_a_long_random_secret
GMAIL_CLIENT_ID=your_google_client_id
GMAIL_CLIENT_SECRET=your_google_client_secret
GMAIL_REDIRECT_URI=http://YOUR_PUBLIC_IP_OR_DOMAIN:4000/api/auth/gmail/callback
BACKEND_URL=http://YOUR_PUBLIC_IP_OR_DOMAIN:4000
FRONTEND_URL=http://YOUR_PUBLIC_IP_OR_DOMAIN
NODE_ENV=production
PORT=4000
```

Why these values matter:
- `DATABASE_URL` matches the local Postgres you just created
- `BACKEND_URL` is used for the tracking pixel URL
- `FRONTEND_URL` is used for OAuth redirects back to the UI
- `PORT=4000` matches the backend code

---

## 8) Install backend dependencies and start the backend

```bash
cd /home/ubuntu/mailflow-backend
npm install --production
```

First test run:

```bash
node src/index.js
```

If you see database or env errors, fix them before continuing. The app should initialize the schema, reset stuck sends, and start listening on port 4000.

Once the test run works, stop it and start with PM2:

```bash
pm2 start src/index.js --name mailflow-backend
pm2 save
pm2 startup systemd
```

Run the `sudo ...` command PM2 prints after `pm2 startup systemd`.

Check backend health:

```bash
curl http://localhost:4000/health
```

---

## 9) Configure the frontend

```bash
cd /home/ubuntu/mailflow-frontend
echo "REACT_APP_API_URL=http://YOUR_PUBLIC_IP_OR_DOMAIN/api" > .env
npm install
npm run build
```

That builds the static frontend into the `build` folder.

---

## 10) Configure nginx

Create `/etc/nginx/sites-available/mailflow` with this content:

```nginx
server {
    listen 80;
    server_name YOUR_PUBLIC_IP_OR_DOMAIN;

    root /home/ubuntu/mailflow-frontend/build;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /track/ {
        proxy_pass http://127.0.0.1:4000/track/;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/mailflow /etc/nginx/sites-enabled/mailflow
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

Now nginx serves the frontend and forwards API requests to the backend.

---

## 11) Update Google OAuth redirect URI

Go back to Google Cloud and replace the redirect URI with the real server URL:

```text
http://YOUR_PUBLIC_IP_OR_DOMAIN:4000/api/auth/gmail/callback
```

If you later add HTTPS and a domain, update it again to the HTTPS URL.

---

## 12) Open the app

1. Open `http://YOUR_PUBLIC_IP_OR_DOMAIN`
2. Create the first MailFlow user in the setup screen
3. Log in
4. Go to Settings and connect Gmail
5. Create a sequence, upload CSV contacts, and launch it

Because the backend is running on the free VM and PM2 keeps it alive, mail sending continues even if your laptop is closed.

---

## 13) Fixes that are already required by the code

These are already handled in the repo changes we made:
- `pgcrypto` is enabled in the schema for UUIDs
- `send_delay_seconds` exists on `sequences`
- the deployment guide uses nginx proxying instead of exposing the frontend dev server

If you ever need to re-run the schema manually:

```bash
sudo -u postgres psql -d mailflow -f /home/ubuntu/mailflow-backend/src/schema.sql
```

---

## 14) Common problems

- If the app does not load, check `pm2 logs mailflow-backend` and `sudo systemctl status nginx`.
- If Gmail login fails, confirm the redirect URI exactly matches the one in Google Cloud.
- If emails do not send, confirm the sequence is active and Gmail is connected.
- If `gen_random_uuid()` fails, re-run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` inside the `mailflow` database.

---

## Best completely free choice

If you want one answer, use this:
- Oracle Cloud Always Free VM
- Ubuntu 22.04
- Local PostgreSQL on the VM
- nginx + PM2

That is the most practical free setup for an always-on app like MailFlow.
