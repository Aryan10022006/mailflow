# MailFlow — AWS EC2 Deployment Guide

This is the recommended deployment path for MailFlow if you want a standard always-on cloud server.

Important note: AWS EC2 usually requires a credit card for account setup and free-tier verification. This guide assumes you are okay with that.

The app runs best on Ubuntu EC2 because the backend already expects a Linux-style process manager, local PostgreSQL, and nginx.

---

## What you will deploy

- 1 AWS EC2 instance running Ubuntu Server 22.04 LTS
- Node.js backend on port 4000
- PostgreSQL on the same server
- PM2 to keep the backend alive
- nginx to serve the frontend and proxy API requests

---

## 1) Set up Gmail API in Google Cloud

1. Open https://console.cloud.google.com
2. Create a project named `MailFlow`
3. Go to `APIs & Services` → `Library`
4. Enable `Gmail API`
5. Go to `OAuth consent screen`
6. Choose `External`
7. Add your Gmail address as a test user
8. Go to `Credentials` → `Create Credentials` → `OAuth client ID`
9. Choose `Web application`
10. Add this redirect URI for now:

```text
http://YOUR_EC2_PUBLIC_IP:4000/api/auth/gmail/callback
```

11. Save the Client ID and Client Secret

---

## 2) Launch the AWS EC2 instance

1. Open AWS Console → EC2 → `Launch instance`
2. Name it `mailflow-server`
3. Choose `Ubuntu Server 22.04 LTS`
4. Instance type: `t2.micro` if you want free tier usage
5. Create or select a key pair and download the `.pem` file
6. In security group inbound rules add:
   - SSH `22` from your IP
   - HTTP `80` from anywhere
   - HTTPS `443` from anywhere if you plan to use SSL
   - Custom TCP `4000` from anywhere if you want direct backend access
7. Launch the instance
8. Wait for the instance status checks to pass

If you want a stable IP, allocate and attach an Elastic IP after the instance is running.

---

## 3) Connect to the server

From your computer:

```powershell
ssh -i C:\path\to\mailflow-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

---

## 4) Install dependencies on the server

Run these commands on the EC2 instance:

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20
c
# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# PM2 and nginx
sudo npm install -g pm2
sudo apt install -y nginx

# Helpful tools
sudo apt install -y git
```

Check versions:

```bash
node --version
psql --version
```

---

## 5) Set up PostgreSQL

MailFlow uses `gen_random_uuid()` in the schema, so `pgcrypto` must be enabled.

```bash
sudo -u postgres psql
```

Inside `psql`:

```sql
CREATE DATABASE mailflow;
CREATE USER mailflow_user WITH ENCRYPTED PASSWORD 'YOUR_DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mailflow TO mailflow_user;
\c mailflow
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

---

## 6) Put the code on the server

Clone from GitHub or copy the files with `scp`.

Example using Git:

```bash
cd ~
git clone <your-repo-url> mailflow
cd mailflow
```

If you copied the repo manually, place it at:

- `/home/ubuntu/mailflow/backend`
- `/home/ubuntu/mailflow/frontend`

---

## 7) Configure the backend

Create `/home/ubuntu/mailflow/backend/.env`:

```text
DATABASE_URL=postgresql://mailflow_user:YOUR_DB_PASSWORD@localhost:5432/mailflow
JWT_SECRET=long_random_secret_here
GMAIL_CLIENT_ID=your_google_client_id
GMAIL_CLIENT_SECRET=your_google_client_secret
GMAIL_REDIRECT_URI=http://YOUR_EC2_PUBLIC_IP:4000/api/auth/gmail/callback
BACKEND_URL=http://YOUR_EC2_PUBLIC_IP:4000
FRONTEND_URL=http://YOUR_EC2_PUBLIC_IP
NODE_ENV=production
PORT=4000
```

Then install backend dependencies:

```bash
cd /home/ubuntu/mailflow/backend
npm install --production
```

Test it once:

```bash
node src/index.js
```

If that starts cleanly, stop it and run it with PM2:

```bash
cd /home/ubuntu/mailflow/backend && pm2 start src/index.js --name mailflow-backend
pm2 save
pm2 startup systemd
```

Run the `sudo ...` command PM2 prints.

Check health:

```bash
curl http://localhost:4000/health
```

---

## 8) Configure the frontend

Build the frontend with the backend API URL baked in:

```bash
cd /home/ubuntu/mailflow/frontend
echo "REACT_APP_API_URL=/api" > .env
npm install
npm run build
```

---

## 9) Configure nginx

Create `/etc/nginx/sites-available/mailflow`:

```nginx
server {
	listen 80;
	server_name YOUR_EC2_PUBLIC_IP;

	root /home/ubuntu/mailflow/frontend/build;
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

If you get a 500 error after nginx reloads, check these first:

```bash
curl http://127.0.0.1:4000/health
sudo tail -n 50 /var/log/nginx/error.log
pm2 logs mailflow-backend --lines 50
ls -l /home/ubuntu/mailflow/frontend/build/index.html
```

If `/health` fails, the backend is the problem. If `/health` works but nginx still returns 500, the nginx config or file permissions are the problem.

---

## 10) Update Google OAuth redirect URI

Set the final redirect URI in Google Cloud to:

```text
http://YOUR_EC2_PUBLIC_IP:4000/api/auth/gmail/callback
```

If you later add a domain and HTTPS, update this URI to match.

---

## 11) Open the app

1. Open `http://YOUR_EC2_PUBLIC_IP`
2. Create your first MailFlow user
3. Log in and connect Gmail
4. Create a sequence, upload contacts, and launch it

Because the backend runs on EC2 with PM2 and the server stays on, scheduled emails, tracking, and reply detection continue even when your laptop is off.

---

## 12) Common checks

- Backend logs: `pm2 logs mailflow-backend`
- Backend restart: `pm2 restart mailflow-backend`
- nginx status: `sudo systemctl status nginx`
- Schema re-run if needed:

```bash
sudo -u postgres psql -d mailflow -f /home/ubuntu/mailflow/backend/src/schema.sql
```

If `smtp_accounts` is still missing, run this exact order instead:

```bash
sudo -u postgres psql -d mailflow -c "CREATE TABLE IF NOT EXISTS smtp_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id integer REFERENCES users(id) ON DELETE CASCADE, smtp_host varchar(255) NOT NULL, smtp_port integer NOT NULL, smtp_user varchar(255) NOT NULL, smtp_password text NOT NULL, display_name varchar(255), is_active boolean DEFAULT true, created_at timestamp DEFAULT NOW(), updated_at timestamp DEFAULT NOW());"
sudo -u postgres psql -d mailflow -c "ALTER TABLE sequences ADD COLUMN IF NOT EXISTS smtp_account_id uuid REFERENCES smtp_accounts(id) ON DELETE SET NULL;"
sudo -u postgres psql -d mailflow -c "\dt smtp_accounts"
sudo -u postgres psql -d mailflow -c "\d sequences"
pm2 restart mailflow-backend --update-env
curl http://127.0.0.1:4000/health
```

---

## 13) Notes

- This is the cleanest path if you want a standard cloud server.
- If you need Windows instead, use `DEPLOYMENT_WINDOWS.md`.
- If you need a completely free no-card option, AWS is not that option.

