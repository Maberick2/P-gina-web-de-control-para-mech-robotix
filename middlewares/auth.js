const jwt = require('jsonwebtoken');

function checkAuth(req, res, next) {
  const token = req.cookies.jwt;

  if (!token) {
    return redirectToLogin(res);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.clearCookie('jwt', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/'
    });
    return redirectToLogin(res);
  }
}

function redirectToLogin(res) {
  res.redirect('/login.html');
}

module.exports = { checkAuth };
