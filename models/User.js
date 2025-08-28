const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  email:  { type: String, required: true, unique: true },
  password:{ type: String, required: true },

  resetPasswordTokenHash: { type: String, default: null },
  resetPasswordExpires:   { type: Date,   default: null }
});

module.exports = mongoose.model('User', UserSchema);
