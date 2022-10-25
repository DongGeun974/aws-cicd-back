
import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import ecr = require('@aws-cdk/aws-ecr');
import eks = require('@aws-cdk/aws-eks');
import iam = require('@aws-cdk/aws-iam');
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import targets = require('@aws-cdk/aws-events-targets');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');



export class CdkStackALBEksBg extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create a new VPC with single NAT Gateway
     */
    const vpc = new ec2.Vpc(this, 'NewVPC', {
      cidr: '10.0.0.0/16',
      natGateways: 1
    });

    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal()
    });

    const controlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      allowAllOutbound: true
    });
    
    controlPlaneSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        "Allow all inbound traffic by default",
    );

    const cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_21,
      securityGroup: controlPlaneSecurityGroup,
      vpc,
      defaultCapacity: 2,
      mastersRole: clusterAdmin,
      outputClusterName: true,
    });
    
    

    const ecrRepoFront = new ecr.Repository(this, 'ecrRepoFront');

    const repositoryFront = new codecommit.Repository(this, 'CodeCommitRepoFront', {
      repositoryName: `${this.stackName}-repo-Front`
    });


    // CODEBUILD - project Front
    const projectFront = new codebuild.Project(this, 'MyProjectFront', {
      projectName: `${this.stackName}`,
      source: codebuild.Source.codeCommit({ repository: repositoryFront }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromAsset(this, 'CustomImage', {
          directory: '../dockerAssets.d',
        }),
        privileged: true
      },
      environmentVariables: {
        'CLUSTER_NAME': {
          value: `${cluster.clusterName}`
        },
        'ECR_REPO_URI_FRONT': {
          value: `${ecrRepoFront.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
              'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output=text)',
              '/usr/local/bin/entrypoint.sh',
              'echo Logging in to Amazon ECR',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'cd CICD-rolling-front',
              `docker build -t $ECR_REPO_URI_FRONT:$TAG .`,
              'docker push $ECR_REPO_URI_FRONT:$TAG'
            ]
          },
          post_build: {
            commands: [
              'kubectl get nodes',
              'kubectl get deploy',
              'kubectl get svc',
              "isDeployed=$(kubectl get deploy -o json | jq '.items[0]')",
              "deploy8080=$(kubectl get svc -o wide | grep 8080: | tr ' ' '\n' | grep app= | sed 's/app=//g')",
              "echo $isDeployed $deploy8080",
              "if [[ \"$isDeployed\" == \"null\" ]]; then kubectl apply -f front.yaml; else kubectl set image deployment rolling-front rolling-front=$ECR_REPO_URI_FRONT:$TAG; fi",
              'kubectl get deploy',
              'kubectl get svc'
            ]
          }
        }
      })
    })
    
    
    const ecrRepoBack = new ecr.Repository(this, 'ecrRepoBack');

    const repositoryBack = new codecommit.Repository(this, 'CodeCommitRepoBack', {
      repositoryName: `${this.stackName}-repo-Back`
    });


    // CODEBUILD - project Back
    const projectBack = new codebuild.Project(this, 'MyProjectBack', {
      projectName: `${this.stackName}`,
      source: codebuild.Source.codeCommit({ repository: repositoryBack }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromAsset(this, 'CustomImage', {
          directory: '../dockerAssets.d',
        }),
        privileged: true
      },
      environmentVariables: {
        'CLUSTER_NAME': {
          value: `${cluster.clusterName}`
        },
        'ECR_REPO_URI_BACK': {
          value: `${ecrRepoBack.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
              'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output=text)',
              '/usr/local/bin/entrypoint.sh',
              'echo Logging in to Amazon ECR',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'cd CICD-rolling-back',
              `docker build -t $ECR_REPO_URI_BACK:$TAG .`,
              'docker push $ECR_REPO_URI_BACK:$TAG'
            ]
          },
          post_build: {
            commands: [
              'kubectl get nodes',
              'kubectl get deploy',
              'kubectl get svc',
              "isDeployed=$(kubectl get deploy -o json | jq '.items[0]')",
              "deploy8080=$(kubectl get svc -o wide | grep 8080: | tr ' ' '\n' | grep app= | sed 's/app=//g')",
              "echo $isDeployed $deploy8080",
              "if [[ \"$isDeployed\" == \"null\" ]]; then kubectl apply -f back.yaml; else kubectl set image deployment rolling-server rolling-server=$ECR_REPO_URI_BACK:$TAG; fi",
              'kubectl get deploy',
              'kubectl get svc'
            ]
          }
        }
      })
    })




    // PIPELINE

    const sourceOutput = new codepipeline.Artifact();

    const sourceActionFront = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository: repositoryFront,
      output: sourceOutput,
    });
    
    const sourceActionBack = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository: repositoryBack,
      output: sourceOutput,
    });

    const buildActionFornt = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: projectFront,
      input: sourceOutput,
      outputs: [new codepipeline.Artifact()], // optional
    });
    
    const buildActionBack = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: projectFront,
      input: sourceOutput,
      outputs: [new codepipeline.Artifact()], // optional
    });
    
    const buildActionFront2 = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: projectFront,
      input: sourceOutput,
    });

    const buildActionBack2 = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: projectBack,
      input: sourceOutput,
    });


    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
    });



    new codepipeline.Pipeline(this, 'MyPipelineFront', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceActionFront],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [buildActionFornt],
        },
        {
          stageName: 'ApproveSwapBG',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'SwapBG',
          actions: [buildActionFront2],
        },
      ],
    });
    
    new codepipeline.Pipeline(this, 'MyPipelineBack', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceActionBack],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [buildActionBack],
        },
        {
          stageName: 'ApproveSwapBG',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'SwapBG',
          actions: [buildActionBack2],
        },
      ],
    });


    repositoryFront.onCommit('OnCommit', {
      target: new targets.CodeBuildProject(projectFront)
    });
    
    repositoryBack.onCommit('OnCommit', {
      target: new targets.CodeBuildProject(projectBack)
    });

    ecrRepoFront.grantPullPush(projectFront.role!)
    cluster.awsAuth.addMastersRole(projectFront.role!)
    projectFront.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }))


    ecrRepoBack.grantPullPush(projectBack.role!)
    cluster.awsAuth.addMastersRole(projectBack.role!)
    projectBack.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }))


    new cdk.CfnOutput(this, 'CodeCommitRepoName', { value: `${repositoryFront.repositoryName}` })
    new cdk.CfnOutput(this, 'CodeCommitRepoArn', { value: `${repositoryFront.repositoryArn}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlSsh', { value: `${repositoryFront.repositoryCloneUrlSsh}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlHttp', { value: `${repositoryFront.repositoryCloneUrlHttp}` })
    
    new cdk.CfnOutput(this, 'CodeCommitRepoName', { value: `${repositoryBack.repositoryName}` })
    new cdk.CfnOutput(this, 'CodeCommitRepoArn', { value: `${repositoryBack.repositoryArn}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlSsh', { value: `${repositoryBack.repositoryCloneUrlSsh}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlHttp', { value: `${repositoryBack.repositoryCloneUrlHttp}` })
  }
}
