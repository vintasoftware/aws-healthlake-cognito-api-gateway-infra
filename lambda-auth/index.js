const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const COGNITO_REGION = process.env.COGNITO_REGION;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const JWKS_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`;

const client = jwksClient({ jwksUri: JWKS_URL });

async function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) reject(err);
      else if (key) resolve(key.getPublicKey());
      else reject('Key not found');
    });
  });
}

exports.handler = async (event) => {
  try {
    console.log('Auth event:', JSON.stringify(event, null, 2));
    
    // Handle missing authorization token
    if (!event.authorizationToken) {
      console.error('Authorization token is missing');
      throw new Error('Unauthorized');
    }
    
    const token = event.authorizationToken.replace('Bearer ', '');
    const decoded = jwt.decode(token, { complete: true });
    
    if (!decoded || !decoded.header || !decoded.payload) {
      console.error('Invalid token format');
      throw new Error('Invalid token format');
    }
    
    console.log('Decoded token header:', JSON.stringify(decoded.header));
    
    // Get the signing key and verify the token
    const signingKey = await getSigningKey(decoded.header.kid);
    const verifiedToken = jwt.verify(token, signingKey, { algorithms: ['RS256'] });
    
    console.log('Verified token payload:', JSON.stringify(verifiedToken));
    
    // Extract user information - use email or preferred_username if available
    const userId = verifiedToken.sub;
    const userName = verifiedToken.email || verifiedToken.preferred_username || verifiedToken.sub;
    const userGroups = verifiedToken['cognito:groups'] || [];
    
    console.log(`User identified as: ${userName} (${userId}), Groups: ${userGroups.join(', ')}`);

    // Define access policies based on groups
    const policies = {
      Administrators: ['*'],
      Practitioners: ['Patient.read', 'Patient.write', 'Observation.read', 'Observation.write'],
      Patients: [`Patient.read?patient=${userId}`, `Observation.read?subject=${userId}`]
    };

    // Get allowed actions based on user groups
    const allowedActions = userGroups.reduce((acc, group) => {
      return [...acc, ...(policies[group] || [])];
    }, []);

    if (allowedActions.length === 0) {
      console.warn('User has no permissions assigned');
      // Still allow the request, but API Gateway can use context to make decisions
    }

    // Create the authorization response with user identity and context
    const authResponse = {
      principalId: userName, // This will appear in the 'user' field in logs
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'execute-api:Invoke',
          Effect: 'Allow',
          Resource: event.methodArn
        }]
      },
      // Pass additional context to API Gateway
      context: {
        userId: userId,
        userName: userName,
        groups: userGroups.join(','),
        scopes: allowedActions.join(','),
      }
    };

    console.log('Auth response:', JSON.stringify(authResponse, null, 2));
    return authResponse;

  } catch (err) {
    console.error('Auth Error:', err.message);
    // Return a standardized deny policy
    return {
      principalId: 'unauthorized',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ 
          Action: 'execute-api:Invoke', 
          Effect: 'Deny', 
          Resource: event.methodArn 
        }],
      },
    };
  }
};
