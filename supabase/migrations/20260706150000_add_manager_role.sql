-- Add a "manager" role for the User Management page (roles: admin, manager, user).
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'manager';
