-- Final review (auth-2, PRD 5.20 and F-109): a first sign-in on the sign-in host makes a working Free business only while
-- sign-up is open (mode 'public' and the day's cap not reached). Otherwise it makes a held place for the person: their
-- session needs a business row to live in, but a held one answers only the sign-in and sign-up routes and has no address
-- of its own. signup.start (with a working invite code, or once sign-up is public) adopts it and clears the flag.
ALTER TABLE tenants ADD COLUMN signup_held boolean NOT NULL DEFAULT false;
