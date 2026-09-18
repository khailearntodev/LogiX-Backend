-- RenameIndex
ALTER INDEX "ix_password_reset_tokens_user_token" RENAME TO "password_reset_tokens_user_id_token_hash_idx";
