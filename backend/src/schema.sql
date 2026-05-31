-- MailFlow Database Schema

-- Ensure UUID functions are available (pgcrypto provides gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users table (single user app)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  gmail_access_token TEXT,
  gmail_refresh_token TEXT,
  gmail_email VARCHAR(255),
  gmail_connected_at TIMESTAMP,
  signature TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- SMTP accounts used as alternate senders
CREATE TABLE IF NOT EXISTS smtp_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  smtp_host VARCHAR(255) NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_user VARCHAR(255) NOT NULL,
  smtp_password TEXT NOT NULL,
  display_name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sequences table
CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id),
  folder_id UUID,
  name VARCHAR(255) NOT NULL,
  send_delay_seconds INTEGER DEFAULT 7,
  status VARCHAR(50) DEFAULT 'draft', -- draft, active, paused, stopped, completed
  from_email VARCHAR(255),
  smtp_account_id UUID REFERENCES smtp_accounts(id) ON DELETE SET NULL,
  csv_filename VARCHAR(255),
  csv_columns JSONB DEFAULT '[]'::jsonb,
  attachment_filename VARCHAR(255),
  attachment_path VARCHAR(500),
  attachment_mimetype VARCHAR(255),
  include_signature BOOLEAN DEFAULT true,
  open_tracking BOOLEAN DEFAULT true,
  daily_limit_hit BOOLEAN DEFAULT false,
  daily_limit_reset_at TIMESTAMP,
  total_contacts INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  replied_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  duplicated_from UUID,
  trashed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(50) DEFAULT '#6c63ff',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS sequences
  ADD COLUMN IF NOT EXISTS folder_id UUID;

ALTER TABLE IF EXISTS sequences
  ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMP;

-- Add missing sequence columns to existing databases
ALTER TABLE IF EXISTS sequences
  ADD COLUMN IF NOT EXISTS smtp_account_id UUID REFERENCES smtp_accounts(id) ON DELETE SET NULL;

-- Emails (steps) within a sequence
CREATE TABLE IF NOT EXISTS sequence_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID REFERENCES sequences(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL, -- 1 = initial, 2,3,4 = follow-ups
  subject VARCHAR(500),
  body TEXT,
  scheduled_at TIMESTAMP, -- for step 1: exact datetime; for follow-ups: null (calculated from delay)
  delay_days INTEGER DEFAULT 0, -- delay from previous step (for follow-ups)
  delay_hours INTEGER DEFAULT 0,
  delay_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS sequence_emails
  ADD COLUMN IF NOT EXISTS delay_minutes INTEGER DEFAULT 0;

-- Contacts imported from CSV
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID REFERENCES sequences(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  data JSONB DEFAULT '{}', -- all CSV columns stored here
  current_step INTEGER DEFAULT 0, -- which step they're on
  status VARCHAR(50) DEFAULT 'pending', -- pending, active, replied, stopped, completed
  reply_detected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Individual email sends (one per contact per step)
CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_email_id UUID REFERENCES sequence_emails(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  to_email VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, sent, failed, skipped, paused
  scheduled_at TIMESTAMP,
  sent_at TIMESTAMP,
  opened_at TIMESTAMP,
  gmail_message_id VARCHAR(255),
  gmail_thread_id VARCHAR(255),
  tracking_pixel_id UUID DEFAULT gen_random_uuid(),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id UUID,
  event_type VARCHAR(100), -- email_sent, email_opened, reply_detected, followup_skipped, limit_reached, sequence_paused, sequence_stopped
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_sends(status);
CREATE INDEX IF NOT EXISTS idx_email_sends_scheduled_at ON email_sends(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_sends_tracking ON email_sends(tracking_pixel_id);
CREATE INDEX IF NOT EXISTS idx_contacts_sequence ON contacts(sequence_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_activity_sequence ON activity_log(sequence_id);
