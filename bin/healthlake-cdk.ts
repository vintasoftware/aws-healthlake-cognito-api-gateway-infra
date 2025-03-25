#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HealthlakeCdkStack, CognitoCertificateStack } from '../lib/healthlake-cdk-stack';

const app = new cdk.App();

// Validate required environment variables
const authDomainName = process.env.AUTH_DOMAIN_NAME;
const apiDomainName = process.env.API_DOMAIN_NAME;
const hostedZoneName = process.env.HOSTED_ZONE_NAME;
const hostedZoneId = process.env.HOSTED_ZONE_ID;
const cognitoCertificateArn = process.env.COGNITO_CERTIFICATE_ARN; // Optional

if (!authDomainName || !apiDomainName || !hostedZoneName || !hostedZoneId) {
  throw new Error(`Missing required environment variables. 
    Required: AUTH_DOMAIN_NAME, API_DOMAIN_NAME, HOSTED_ZONE_NAME, HOSTED_ZONE_ID
    Optional: COGNITO_CERTIFICATE_ARN`);
}

// If no certificate ARN is provided, create the certificate stack in us-east-1
if (!cognitoCertificateArn) {
  const certStack = new CognitoCertificateStack(app, 'CognitoCertificateStack', {
    authDomainName,
    hostedZoneName,
    hostedZoneId,
  });
  
  // Output the certificate ARN with instructions
  new cdk.CfnOutput(certStack, 'CertificateInstructions', {
    value: 'Deploy this stack first to create the certificate in us-east-1. Then set the COGNITO_CERTIFICATE_ARN environment variable to the output value above and deploy the main stack.'
  });
}

// Create the main HealthLake stack
new HealthlakeCdkStack(app, 'TestHealthlakeCdkStack', {
  authDomainName,
  apiDomainName,
  hostedZoneName,
  hostedZoneId,
  cognitoCertificateArn,
});